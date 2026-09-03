const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onValueCreated} = require("firebase-functions/v2/database");
const {initializeApp} = require("firebase-admin/app");
const {getDatabase} = require("firebase-admin/database");

initializeApp();
const db=getDatabase();

function cleanText(value,max=28){
  return String(value||"").trim().replace(/[<>]/g,"").slice(0,max);
}
function tournamentNameKey(value=""){
  const normalized=String(value).trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ");
  return Buffer.from(normalized,"utf8").toString("base64url");
}
function roomCode(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out="";
  for(let i=0;i<6;i++) out+=chars[Math.floor(Math.random()*chars.length)];
  return out;
}
async function profileFor(uid){
  const snap=await db.ref(`users/${uid}/profile`).get();
  if(!snap.exists()) throw new HttpsError("failed-precondition","El jugador no tiene perfil.");
  return snap.val();
}
function requireAuth(request){
  if(!request.auth) throw new HttpsError("unauthenticated","Tenés que iniciar sesión.");
  return request.auth.uid;
}
function baseTournamentGame(code,a,b,tournamentId,matchId){
  return {
    version:2,roomCode:code,status:"playing",
    playerAUid:a.uid,playerBUid:b.uid,playerAName:a.username,playerBName:b.username,
    money:{A:20,B:20},teams:{A:[],B:[]},usedPlayers:[],currentPlayerIndex:null,
    firstBidder:"A",currentBidder:"A",leader:null,currentBid:0,zeroBidPasses:0,
    consecutivePasses:{A:0,B:0},forceOpeningBid:false,goalkeeperPhase:true,
    rngSeed:(Date.now()>>>0),result:null,miniMatch:null,
    tournamentId, tournamentMatchId:matchId,
    message:"🏆 Partido de torneo listo. Comienza la fase de arqueros."
  };
}

exports.resolveLoginEmail=onCall(async request=>{
  const identifier=cleanText(request.data?.identifier,80).toLowerCase();
  if(!/^[a-z0-9_]{3,16}$/.test(identifier)){
    throw new HttpsError("invalid-argument","Ingresá un usuario o correo válido.");
  }
  const uidSnap=await db.ref(`usernames/${identifier}`).get();
  if(!uidSnap.exists()){
    throw new HttpsError("not-found","Usuario o contraseña incorrectos.");
  }
  const emailSnap=await db.ref(`users/${uidSnap.val()}/profile/email`).get();
  const email=emailSnap.val();
  if(!email){
    throw new HttpsError("not-found","Usuario o contraseña incorrectos.");
  }
  return {email};
});

exports.createTournament=onCall(async request=>{
  const uid=requireAuth(request), name=cleanText(request.data?.name);
  if(name.length<3) throw new HttpsError("invalid-argument","El nombre debe tener al menos 3 caracteres.");

  const nameKey=tournamentNameKey(name);
  const existing=(await db.ref("tournaments").get()).val()||{};
  const duplicate=Object.values(existing).some(t=>
    t?.status!=="completed" && tournamentNameKey(t?.name)===nameKey
  );
  if(duplicate) throw new HttpsError("already-exists","Ya existe un torneo activo con ese nombre.");

  const p=await profileFor(uid), tournamentRef=db.ref("tournaments").push();
  const nameRef=db.ref(`tournamentNames/${nameKey}`);
  const reservedId=(await nameRef.get()).val();
  if(reservedId){
    const reservedTournament=(await db.ref(`tournaments/${reservedId}`).get()).val();
    if(!reservedTournament || reservedTournament.status==="completed"){
      await nameRef.transaction(current=>current===reservedId?null:current);
    }
  }
  const claimed=await nameRef.transaction(current=>current===null?tournamentRef.key:undefined);
  if(!claimed.committed){
    throw new HttpsError("already-exists","Ya existe un torneo activo con ese nombre.");
  }

  try{
    await tournamentRef.set({
      name,nameKey,ownerUid:uid,status:"waiting",createdAt:Date.now(),
      participants:{[uid]:{uid,username:p.username,joinedAt:Date.now()}}
    });
  }catch(error){
    await nameRef.transaction(current=>current===tournamentRef.key?null:current);
    throw error;
  }
  return {tournamentId:tournamentRef.key};
});

exports.deleteTournament=onCall(async request=>{
  const uid=requireAuth(request);
  const tournamentId=cleanText(request.data?.tournamentId,80);
  if(!tournamentId) throw new HttpsError("invalid-argument","Falta el torneo.");

  const target=db.ref(`tournaments/${tournamentId}`);
  const initial=(await target.get()).val();
  if(!initial) throw new HttpsError("not-found","El torneo ya no existe.");
  if(initial.ownerUid!==uid) throw new HttpsError("permission-denied","Solo el creador puede eliminar este torneo.");

  // El propietario ya fue validado contra el estado actual del torneo.
  // remove() evita que una eliminación válida quede marcada como transacción abortada.
  await target.remove();
  const nameKey=initial.nameKey||tournamentNameKey(initial.name);
  if(nameKey){
    await db.ref(`tournamentNames/${nameKey}`).transaction(
      current=>current===tournamentId?null:current
    );
  }

  const cleanup={};
  Object.values(initial.matches||{}).forEach(match=>{
    const code=cleanText(match?.roomCode,12);
    if(!code) return;
    cleanup[`games/${code}`]=null;
    cleanup[`matches/${code}`]=null;
  });
  if(Object.keys(cleanup).length) await db.ref().update(cleanup);
  return {ok:true};
});

exports.joinTournament=onCall(async request=>{
  const uid=requireAuth(request);
  const tournamentId=cleanText(request.data?.tournamentId,80);
  if(!tournamentId) throw new HttpsError("invalid-argument","Falta el torneo.");

  const p=await profileFor(uid);
  const target=db.ref(`tournaments/${tournamentId}`);
  const initial=(await target.get()).val();

  if(!initial) throw new HttpsError("not-found","El torneo ya no existe.");
  if(initial.status!=="waiting") throw new HttpsError("failed-precondition","El torneo ya comenzó.");

  const participantsRef=target.child("participants");
  const joined=await participantsRef.transaction(participants=>{
    participants=participants||{};
    if(participants[uid]) return participants;
    if(Object.keys(participants).length>=4) return;
    participants[uid]={uid,username:p.username,joinedAt:Date.now()};
    return participants;
  });

  if(!joined.committed){
    throw new HttpsError("resource-exhausted","El torneo ya tiene cuatro jugadores.");
  }

  const people=Object.values(joined.snapshot.val()||{}).sort((a,b)=>a.joinedAt-b.joinedAt);
  if(!people.some(player=>player.uid===uid)){
    throw new HttpsError("resource-exhausted","El torneo ya tiene cuatro jugadores.");
  }

  if(people.length===4){
    await target.transaction(t=>{
      if(!t || t.status!=="waiting" || t.matches) return t;
      const ordered=Object.values(t.participants||{}).sort((a,b)=>a.joinedAt-b.joinedAt);
      if(ordered.length!==4) return t;
      t.status="semifinals";
      t.startedAt=Date.now();
      t.matches={
        semifinal1:{label:"SEMIFINAL 1",status:"ready",playerAUid:ordered[0].uid,playerAName:ordered[0].username,playerBUid:ordered[3].uid,playerBName:ordered[3].username},
        semifinal2:{label:"SEMIFINAL 2",status:"ready",playerAUid:ordered[1].uid,playerAName:ordered[1].username,playerBUid:ordered[2].uid,playerBName:ordered[2].username},
        final:{label:"FINAL",status:"pending"}
      };
      return t;
    });
  }

  return {ok:true,participants:people.length};
});

exports.openTournamentMatch=onCall(async request=>{
  const uid=requireAuth(request);
  const tournamentId=cleanText(request.data?.tournamentId,80);
  const matchId=cleanText(request.data?.matchId,30);
  const matchRef=db.ref(`tournaments/${tournamentId}/matches/${matchId}`);
  const initial=(await matchRef.get()).val();
  if(!initial) throw new HttpsError("not-found","No existe ese partido.");
  if(![initial.playerAUid,initial.playerBUid].includes(uid)) throw new HttpsError("permission-denied","No participás de este partido.");
  if(!["ready","playing"].includes(initial.status) || initial.winnerUid) throw new HttpsError("failed-precondition","Ese partido no está disponible.");

  const proposedCode=roomCode();
  const locked=await matchRef.transaction(match=>{
    if(!match || match.winnerUid || !["ready","playing"].includes(match.status)) return;
    if(!match.roomCode) match.roomCode=proposedCode;
    match.status="playing";
    return match;
  });
  if(!locked.committed) throw new HttpsError("aborted","El cruce cambió. Actualizá e intentá nuevamente.");
  const match=locked.snapshot.val(), code=match.roomCode;
  const gameRef=db.ref(`games/${code}`);
  const gameTx=await gameRef.transaction(current=>current||baseTournamentGame(
    code,
    {uid:match.playerAUid,username:match.playerAName},
    {uid:match.playerBUid,username:match.playerBName},
    tournamentId,matchId
  ));
  if(!gameTx.committed) throw new HttpsError("internal","No se pudo preparar la partida.");
  return {roomCode:code};
});

function validOfficialResult(game,result){
  if(!game?.playerAUid || !game?.playerBUid || game.playerAUid===game.playerBUid) return false;
  if(!Array.isArray(game.teams?.A) || !Array.isArray(game.teams?.B) || game.teams.A.length!==5 || game.teams.B.length!==5) return false;
  const ga=Number(result?.goalsA), gb=Number(result?.goalsB);
  if(!Number.isInteger(ga)||!Number.isInteger(gb)||ga<0||gb<0||ga>20||gb>20) return false;
  if(Number(game.miniMatch?.score?.A)!==ga || Number(game.miniMatch?.score?.B)!==gb) return false;
  const expected=ga>gb?"A":gb>ga?"B":"DRAW";
  return result.winner===expected;
}
async function applyUserResult(uid,room,entry,outcome,goalsFor,goalsAgainst){
  await db.ref(`users/${uid}`).transaction(user=>{
    if(!user) return;
    user.appliedMatches=user.appliedMatches||{};
    if(user.appliedMatches[room]) return user;
    user.appliedMatches[room]=true;
    user.stats={played:0,won:0,drawn:0,lost:0,goalsFor:0,goalsAgainst:0,...(user.stats||{})};
    user.stats.played++; user.stats.goalsFor+=goalsFor; user.stats.goalsAgainst+=goalsAgainst;
    if(outcome==="win")user.stats.won++; else if(outcome==="loss")user.stats.lost++; else user.stats.drawn++;
    user.history=user.history||{}; user.history[room]=entry;
    return user;
  });
}
async function advanceTournament(game,result,winnerUid,winnerName){
  if(!game.tournamentId || !game.tournamentMatchId) return;
  const tournamentRef=db.ref(`tournaments/${game.tournamentId}`);
  const advanced=await tournamentRef.transaction(t=>{
    const match=t?.matches?.[game.tournamentMatchId];
    if(!match || match.winnerUid) return t;
    if(!winnerUid){
      match.status="ready"; match.roomCode=null; match.draws=Number(match.draws||0)+1;
      return t;
    }
    match.winnerUid=winnerUid;match.winnerName=winnerName;match.status="completed";
    match.score={A:result.goalsA,B:result.goalsB};
    if(game.tournamentMatchId==="final"){
      t.status="completed";t.winnerUid=winnerUid;t.winnerName=winnerName;t.finishedAt=Date.now();
    }else{
      const s1=t.matches.semifinal1, s2=t.matches.semifinal2;
      if(s1?.winnerUid&&s2?.winnerUid){
        t.status="final";
        t.matches.final={...(t.matches.final||{}),label:"FINAL",status:"ready",playerAUid:s1.winnerUid,playerAName:s1.winnerName,playerBUid:s2.winnerUid,playerBName:s2.winnerName};
      }
    }
    return t;
  });

  const tournament=advanced.snapshot.val();
  if(game.tournamentMatchId!=="final" || !winnerUid || tournament?.status!=="completed") return;

  const nameKey=tournament.nameKey||tournamentNameKey(tournament.name);
  await Promise.all([
    nameKey?db.ref(`tournamentNames/${nameKey}`).transaction(
      current=>current===game.tournamentId?null:current
    ):Promise.resolve(),
    db.ref(`users/${winnerUid}`).transaction(user=>{
      if(!user) return;
      user.appliedTournaments=user.appliedTournaments||{};
      if(user.appliedTournaments[game.tournamentId]) return user;
      user.appliedTournaments[game.tournamentId]=true;
      user.stats={played:0,won:0,drawn:0,lost:0,goalsFor:0,goalsAgainst:0,tournamentsWon:0,...(user.stats||{})};
      user.stats.tournamentsWon=Number(user.stats.tournamentsWon||0)+1;
      return user;
    })
  ]);
}

exports.recordOfficialResult=onValueCreated("/games/{room}/result",async event=>{
  const room=event.params.room, result=event.data.val();
  const game=(await event.data.ref.parent.get()).val();
  if(!validOfficialResult(game,result)){
    console.warn("Resultado rechazado",room);
    await event.data.ref.remove();
    await event.data.ref.parent.update({status:"playing",message:"⚠️ El resultado no superó la validación del servidor."});
    return;
  }
  const matchRef=db.ref(`matches/${room}`);
  const created=await matchRef.transaction(current=>current||{
    roomCode:room,playerAUid:game.playerAUid,playerBUid:game.playerBUid,
    playerAName:game.playerAName||"Equipo Azul",playerBName:game.playerBName||"Equipo Rojo",
    goalsA:result.goalsA,goalsB:result.goalsB,winner:result.winner,
    tournamentId:game.tournamentId||null,tournamentMatchId:game.tournamentMatchId||null,
    finishedAt:Date.now()
  });
  if(!created.committed || created.snapshot.val().processed) return;
  const aWin=result.winner==="A", bWin=result.winner==="B";
  const common={finishedAt:Date.now(),tournamentId:game.tournamentId||null};
  const tournamentName=game.tournamentId?(await db.ref(`tournaments/${game.tournamentId}/name`).get()).val():null;
  await Promise.all([
    applyUserResult(game.playerAUid,room,{...common,tournamentName,opponentUid:game.playerBUid,opponentName:game.playerBName||"Equipo Rojo",myGoals:result.goalsA,opponentGoals:result.goalsB,outcome:aWin?"win":bWin?"loss":"draw"},aWin?"win":bWin?"loss":"draw",result.goalsA,result.goalsB),
    applyUserResult(game.playerBUid,room,{...common,tournamentName,opponentUid:game.playerAUid,opponentName:game.playerAName||"Equipo Azul",myGoals:result.goalsB,opponentGoals:result.goalsA,outcome:bWin?"win":aWin?"loss":"draw"},bWin?"win":aWin?"loss":"draw",result.goalsB,result.goalsA)
  ]);
  const winnerUid=aWin?game.playerAUid:bWin?game.playerBUid:null;
  const winnerName=aWin?(game.playerAName||"Equipo Azul"):bWin?(game.playerBName||"Equipo Rojo"):null;
  await advanceTournament(game,result,winnerUid,winnerName);
  await matchRef.child("processed").set(true);
});

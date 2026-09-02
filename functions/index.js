const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onValueCreated} = require("firebase-functions/v2/database");
const {initializeApp} = require("firebase-admin/app");
const {getDatabase} = require("firebase-admin/database");

initializeApp();
const db=getDatabase();

function cleanText(value,max=28){
  return String(value||"").trim().replace(/[<>]/g,"").slice(0,max);
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

exports.createTournament=onCall(async request=>{
  const uid=requireAuth(request), name=cleanText(request.data?.name);
  if(name.length<3) throw new HttpsError("invalid-argument","El nombre debe tener al menos 3 caracteres.");
  const p=await profileFor(uid), tournamentRef=db.ref("tournaments").push();
  await tournamentRef.set({
    name,ownerUid:uid,status:"waiting",createdAt:Date.now(),
    participants:{[uid]:{uid,username:p.username,joinedAt:Date.now()}}
  });
  return {tournamentId:tournamentRef.key};
});

exports.joinTournament=onCall(async request=>{
  const uid=requireAuth(request), tournamentId=cleanText(request.data?.tournamentId,80);
  if(!tournamentId) throw new HttpsError("invalid-argument","Falta el torneo.");
  const p=await profileFor(uid), target=db.ref(`tournaments/${tournamentId}`);
  const tx=await target.transaction(t=>{
    if(!t || t.status!=="waiting") return;
    t.participants=t.participants||{};
    if(t.participants[uid]) return t;
    if(Object.keys(t.participants).length>=4) return;
    t.participants[uid]={uid,username:p.username,joinedAt:Date.now()};
    const people=Object.values(t.participants).sort((a,b)=>a.joinedAt-b.joinedAt);
    if(people.length===4){
      t.status="semifinals";
      t.startedAt=Date.now();
      t.matches={
        semifinal1:{label:"SEMIFINAL 1",status:"ready",playerAUid:people[0].uid,playerAName:people[0].username,playerBUid:people[3].uid,playerBName:people[3].username},
        semifinal2:{label:"SEMIFINAL 2",status:"ready",playerAUid:people[1].uid,playerAName:people[1].username,playerBUid:people[2].uid,playerBName:people[2].username},
        final:{label:"FINAL",status:"pending"}
      };
    }
    return t;
  });
  if(!tx.committed) throw new HttpsError("failed-precondition","El torneo ya comenzó o está completo.");
  return {ok:true};
});

exports.openTournamentMatch=onCall(async request=>{
  const uid=requireAuth(request);
  const tournamentId=cleanText(request.data?.tournamentId,80);
  const matchId=cleanText(request.data?.matchId,30);
  const tRef=db.ref(`tournaments/${tournamentId}`);
  const snap=await tRef.get(), tournament=snap.val(), match=tournament?.matches?.[matchId];
  if(!match) throw new HttpsError("not-found","No existe ese partido.");
  if(![match.playerAUid,match.playerBUid].includes(uid)) throw new HttpsError("permission-denied","No participás de este partido.");
  if(!["ready","playing"].includes(match.status) || match.winnerUid) throw new HttpsError("failed-precondition","Ese partido no está disponible.");
  if(match.roomCode){
    const game=await db.ref(`games/${match.roomCode}`).get();
    if(game.exists()) return {roomCode:match.roomCode};
  }
  const code=roomCode();
  const a={uid:match.playerAUid,username:match.playerAName};
  const b={uid:match.playerBUid,username:match.playerBName};
  await db.ref().update({
    [`games/${code}`]:baseTournamentGame(code,a,b,tournamentId,matchId),
    [`tournaments/${tournamentId}/matches/${matchId}/roomCode`]:code,
    [`tournaments/${tournamentId}/matches/${matchId}/status`]:"playing"
  });
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
  await db.ref(`tournaments/${game.tournamentId}`).transaction(t=>{
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

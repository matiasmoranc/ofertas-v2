const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onValueCreated} = require("firebase-functions/v2/database");
const {initializeApp} = require("firebase-admin/app");
const {getDatabase, ServerValue} = require("firebase-admin/database");
const {getAuth} = require("firebase-admin/auth");

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
async function requireAdmin(uid){
  const adminUid=(await db.ref("usernames/pinar93").get()).val();
  if(!adminUid || adminUid!==uid){
    throw new HttpsError("permission-denied","Solo pinar93 puede usar el panel de administración.");
  }
}
function baseTournamentGame(code,a,b,tournamentId,matchId){
  return {
    version:2,roomCode:code,status:"playing",
    playerAUid:a.uid,playerBUid:b.uid,playerAName:a.username,playerBName:b.username,
    money:{A:20,B:20},teams:{A:[],B:[]},usedPlayers:[],currentPlayerIndex:null,
    firstBidder:"A",currentBidder:"A",leader:null,currentBid:0,zeroBidPasses:0,
    consecutivePasses:{A:0,B:0},forceOpeningBid:false,goalkeeperPhase:true,
    rngSeed:(Date.now()>>>0),result:null,miniMatch:null,
    matchInstanceId:`${code}-${Date.now()}-${matchId}`,
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


  if(String(request.data?.action||"").startsWith("admin")){
    await requireAdmin(uid);
    const action=request.data.action;

    if(action==="adminSnapshot"){
      const [usersSnap,tournamentsSnap]=await Promise.all([
        db.ref("users").get(),db.ref("tournaments").get()
      ]);
      const users=Object.entries(usersSnap.val()||{}).map(([userUid,user])=>({
        uid:userUid,
        username:cleanText(user?.profile?.username||"Sin usuario",40),
        stats:{
          played:Number(user?.stats?.played||0),
          won:Number(user?.stats?.won||0),
          drawn:Number(user?.stats?.drawn||0),
          lost:Number(user?.stats?.lost||0),
          tournamentsWon:Number(user?.stats?.tournamentsWon||0)
        }
      })).sort((a,b)=>a.username.localeCompare(b.username));
      const tournaments=Object.entries(tournamentsSnap.val()||{}).map(([id,tournament])=>({
        id,name:cleanText(tournament?.name||"Torneo",50),status:tournament?.status||"waiting",
        participants:Object.values(tournament?.participants||{}).map(player=>({
          uid:player?.uid||"",
          username:cleanText(player?.username||"Sin usuario",40)
        })),
        matches:Object.entries(tournament?.matches||{}).map(([matchId,match])=>({
          matchId,status:match?.status||"pending",
          label:cleanText(match?.label||matchId,40),
          playerAName:cleanText(match?.playerAName||"Por definir",40),
          playerBName:cleanText(match?.playerBName||"Por definir",40),
          winnerUid:match?.winnerUid||null,
          roomCode:match?.roomCode||null
        }))
      })).sort((a,b)=>a.name.localeCompare(b.name));
      return {users,tournaments};
    }

    if(action==="adminSetCups"){
      const targetUid=cleanText(request.data?.targetUid,128);
      const cups=Number(request.data?.cups);
      if(!targetUid || !Number.isInteger(cups) || cups<0 || cups>999){
        throw new HttpsError("invalid-argument","La cantidad de copas no es válida.");
      }
      const target=db.ref(`users/${targetUid}`);
      if(!(await target.get()).exists()) throw new HttpsError("not-found","El usuario no existe.");
      await target.child("stats/tournamentsWon").set(cups);
      return {ok:true};
    }

    if(action==="adminResetStats"){
      const targetUid=cleanText(request.data?.targetUid,128);
      const target=db.ref(`users/${targetUid}`);
      const current=(await target.get()).val();
      if(!current) throw new HttpsError("not-found","El usuario no existe.");
      const cups=Number(current?.stats?.tournamentsWon||0);
      await target.child("stats").set({
        played:0,won:0,drawn:0,lost:0,goalsFor:0,goalsAgainst:0,tournamentsWon:cups
      });
      await Promise.all([
        target.child("history").remove(),
        target.child("appliedMatches").remove()
      ]);
      return {ok:true};
    }

    if(action==="adminDeleteUser"){
      const targetUid=cleanText(request.data?.targetUid,128);
      if(!targetUid || targetUid===uid) throw new HttpsError("failed-precondition","No podés eliminar la cuenta administradora.");
      const userRef=db.ref(`users/${targetUid}`);
      const user=(await userRef.get()).val();
      if(!user) throw new HttpsError("not-found","El usuario no existe.");
      const tournaments=(await db.ref("tournaments").get()).val()||{};
      const active=Object.values(tournaments).some(t=>t?.status!=="completed" && t?.participants?.[targetUid]);
      if(active) throw new HttpsError("failed-precondition","El usuario participa en un torneo activo. Terminá o eliminá ese torneo primero.");
      const usernameKey=user?.profile?.usernameKey;
      const games=(await db.ref("games").get()).val()||{};
      const cleanup={};
      for(const [code,game] of Object.entries(games)){
        if(!game?.result && [game?.playerAUid,game?.playerBUid].includes(targetUid)){
          cleanup[`games/${code}`]=null;
          cleanup[`openRooms/${code}`]=null;
        }
      }
      cleanup[`users/${targetUid}`]=null;
      if(usernameKey) cleanup[`usernames/${usernameKey}`]=null;
      await db.ref().update(cleanup);
      try{ await getAuth().deleteUser(targetUid); }
      catch(error){ if(error?.code!=="auth/user-not-found") throw error; }
      return {ok:true};
    }

    if(action==="adminRemoveParticipant"){
      const tournamentId=cleanText(request.data?.tournamentId,80);
      const targetUid=cleanText(request.data?.targetUid,128);
      const tournamentRef=db.ref(`tournaments/${tournamentId}`);
      const initial=(await tournamentRef.get()).val();
      if(!initial) throw new HttpsError("not-found","La copa no existe.");
      if(initial.status!=="waiting" || initial.matches){
        throw new HttpsError("failed-precondition","La copa ya comenzó. No se puede quitar un jugador sin romper el cuadro.");
      }
      if(!initial.participants?.[targetUid]){
        throw new HttpsError("not-found","Ese jugador ya no participa en la copa.");
      }
      await tournamentRef.child(`participants/${targetUid}`).remove();
      const confirmed=(await tournamentRef.get()).val();
      if(confirmed?.participants?.[targetUid]){
        throw new HttpsError("aborted","No se pudo quitar al jugador de la copa.");
      }
      return {ok:true};
    }

    if(action==="adminDeleteTournament"){
      const tournamentId=cleanText(request.data?.tournamentId,80);
      const tournamentRef=db.ref(`tournaments/${tournamentId}`);
      const tournament=(await tournamentRef.get()).val();
      if(!tournament) throw new HttpsError("not-found","El torneo no existe.");
      const cleanup={[`tournaments/${tournamentId}`]:null};
      const nameKey=tournament.nameKey||tournamentNameKey(tournament.name);
      if(nameKey) cleanup[`tournamentNames/${nameKey}`]=null;
      for(const match of Object.values(tournament.matches||{})){
        const code=cleanText(match?.roomCode,12);
        if(code){cleanup[`games/${code}`]=null;cleanup[`matches/${code}`]=null;}
      }
      await db.ref().update(cleanup);
      return {ok:true};
    }

    if(action==="adminResetMatch"){
      const tournamentId=cleanText(request.data?.tournamentId,80);
      const matchId=cleanText(request.data?.matchId,30);
      const matchRef=db.ref(`tournaments/${tournamentId}/matches/${matchId}`);
      const match=(await matchRef.get()).val();
      if(!match) throw new HttpsError("not-found","El partido no existe.");
      if(match.winnerUid) throw new HttpsError("failed-precondition","El partido ya tiene ganador y no puede reiniciarse desde este panel.");
      const code=cleanText(match.roomCode,12);
      await matchRef.update({status:"ready",roomCode:null,readyPlayers:null,startedAt:null});
      if(code) await db.ref().update({[`games/${code}`]:null,[`matches/${code}`]:null,[`openRooms/${code}`]:null});
      return {ok:true};
    }

    throw new HttpsError("invalid-argument","Acción administrativa desconocida.");
  }


  if(request.data?.action==="leaveTournament"){
    const tournamentId=cleanText(request.data?.tournamentId,80);
    if(!tournamentId) throw new HttpsError("invalid-argument","Falta el torneo.");

    const target=db.ref(`tournaments/${tournamentId}`);
    const initial=(await target.get()).val();
    if(!initial) throw new HttpsError("not-found","El torneo ya no existe.");
    if(initial.status!=="waiting" || initial.matches){
      throw new HttpsError("failed-precondition","El torneo ya comenzó y no podés salir.");
    }
    if(!initial.participants?.[uid]){
      throw new HttpsError("failed-precondition","No participás de este torneo.");
    }

    const left=await target.transaction(tournament=>{
      if(!tournament || tournament.status!=="waiting" || tournament.matches) return;
      if(!tournament.participants?.[uid]) return tournament;
      delete tournament.participants[uid];
      return tournament;
    });
    if(!left.committed){
      throw new HttpsError("failed-precondition","El torneo se completó y ya no podés salir.");
    }
    if(left.snapshot.val()?.participants?.[uid]){
      throw new HttpsError("aborted","No se pudo salir del torneo.");
    }
    return {ok:true};
  }

  // Reutilizamos esta función ya autorizada para reparar resultados
  // pendientes, evitando crear otro servicio con permisos IAM nuevos.
  if(request.data?.action==="syncResults"){
    const games=(await db.ref("games").get()).val()||{};
    let processed=0;
    for(const [room,game] of Object.entries(games)){
      if(!game?.result || ![game.playerAUid,game.playerBUid].includes(uid)) continue;
      const outcome=await processOfficialGame(room,game,game.result);
      if(outcome.processed) processed++;
    }
    return {ok:true,processed};
  }

  if(request.data?.action==="syncResult"){
    const code=cleanText(request.data?.roomCode,12);
    if(!code) throw new HttpsError("invalid-argument","Falta la sala.");
    const game=(await db.ref(`games/${code}`).get()).val();
    if(!game) throw new HttpsError("not-found","La partida ya no existe.");
    if(![game.playerAUid,game.playerBUid].includes(uid)){
      throw new HttpsError("permission-denied","No participás de esta partida.");
    }
    if(!game.result) throw new HttpsError("failed-precondition","El partido todavía no tiene resultado.");
    const outcome=await processOfficialGame(code,game,game.result);
    if(outcome.reason==="invalid-result"){
      throw new HttpsError("failed-precondition","El resultado no es válido.");
    }
    return {ok:true,processed:outcome.processed};
  }

  const tournamentId=cleanText(request.data?.tournamentId,80);
  const matchId=cleanText(request.data?.matchId,30);
  const matchRef=db.ref(`tournaments/${tournamentId}/matches/${matchId}`);
  const initial=(await matchRef.get()).val();
  if(!initial) throw new HttpsError("not-found","No existe ese partido.");
  if(![initial.playerAUid,initial.playerBUid].includes(uid)) throw new HttpsError("permission-denied","No participás de este partido.");
  if(request.data?.action==="expireReady"){
    const cutoff=Date.now()-(10*60*1000);
    const expired=await matchRef.transaction(current=>{
      if(!current || current.winnerUid || current.status!=="ready") return current;
      const readyPlayers=current.readyPlayers||{};
      let changed=false;
      for(const [playerUid,ready] of Object.entries(readyPlayers)){
        if(Number(ready?.readyAt||0)<=cutoff){
          delete readyPlayers[playerUid];
          changed=true;
        }
      }
      if(!changed) return;
      current.readyPlayers=Object.keys(readyPlayers).length?readyPlayers:null;
      current.status="ready";
      current.startedAt=null;
      current.roomCode=null;
      return current;
    });
    return {ok:true,expired:expired.committed};
  }

  if(request.data?.action==="entered"){
    const code=cleanText(request.data?.roomCode,12);
    if(initial.status!=="playing" || !initial.roomCode || code!==initial.roomCode){
      throw new HttpsError("failed-precondition","La sala ya no está disponible.");
    }
    const gameRef=db.ref(`games/${code}`);
    const game=(await gameRef.get()).val();
    if(!game || game.result || game.status!=="playing"){
      return {ok:true,alreadyFinished:true};
    }
    if(![game.playerAUid,game.playerBUid].includes(uid)){
      throw new HttpsError("permission-denied","No participás de esta partida.");
    }
    await gameRef.child(`enteredPlayers/${uid}`).set({enteredAt:Date.now()});
    return {ok:true};
  }

  if(request.data?.action==="cancelReady"){
    // Recupera tanto esperas normales como salas residuales que fueron
    // reservadas pero donde el mercado nunca llegó a comenzar.
    const staleCode=cleanText(initial.roomCode,12);
    let staleGame=null;
    if(staleCode) staleGame=(await db.ref(`games/${staleCode}`).get()).val();
    const untouchedGame=!staleGame || (
      !staleGame.result &&
      !staleGame.miniMatch &&
      (!Array.isArray(staleGame.teams?.A) || staleGame.teams.A.length===0) &&
      (!Array.isArray(staleGame.teams?.B) || staleGame.teams.B.length===0) &&
      Number(staleGame.money?.A??20)===20 &&
      Number(staleGame.money?.B??20)===20
    );
    if(staleCode && !untouchedGame){
      throw new HttpsError("failed-precondition","El partido ya comenzó y no se puede cancelar la espera.");
    }
    // El jugador y su pertenencia al cruce ya fueron validados contra
    // el estado actual. Una actualización directa evita falsos abortos
    // de la transacción al limpiar campos residuales.
    await matchRef.update({
      readyPlayers:null,
      startedAt:null,
      roomCode:null,
      status:"ready"
    });
    if(staleCode){
      await Promise.all([
        db.ref(`games/${staleCode}`).remove(),
        db.ref(`matches/${staleCode}`).remove()
      ]);
    }
    return {ok:true};
  }

  // Para jugar o abandonar, el cruce sí debe continuar disponible.
  // La recuperación anterior se ejecuta antes porque también repara estados
  // antiguos o inconsistentes que no coinciden con ready/playing.
  if(!["ready","playing"].includes(initial.status) || initial.winnerUid){
    throw new HttpsError("failed-precondition","Ese partido no está disponible.");
  }

  if(request.data?.action==="forfeit"){
    if(initial.status!=="playing" || !initial.roomCode){
      return {ok:true,alreadyFinished:true};
    }
    const code=initial.roomCode;
    const gameRef=db.ref(`games/${code}`);
    const game=(await gameRef.get()).val();
    if(!game || game.result || game.status!=="playing"){
      return {ok:true,alreadyFinished:true};
    }
    const opponentUid=game.playerAUid===uid?game.playerBUid:game.playerAUid;
    if(!game.enteredPlayers?.[opponentUid]){
      await matchRef.update({
        readyPlayers:null,
        startedAt:null,
        roomCode:null,
        status:"ready"
      });
      await Promise.all([
        gameRef.remove(),
        db.ref(`matches/${code}`).remove()
      ]);
      return {ok:true,pending:true};
    }
    const forfeited=await gameRef.transaction(current=>{
      if(!current || current.result || current.status!=="playing") return;
      const loser=current.playerAUid===uid?"A":"B";
      const winner=loser==="A"?"B":"A";
      current.status="finished";
      current.message=`🏳️ ${loser==="A"?(current.playerAName||"Equipo Azul"):(current.playerBName||"Equipo Rojo")} abandonó. Victoria 3–0.`;
      current.result={
        goalsA:winner==="A"?3:0,
        goalsB:winner==="B"?3:0,
        winner,
        forfeit:true,
        forfeitedBy:uid,
        fromMiniMatch:false
      };
      return current;
    });
    return {ok:true,alreadyFinished:!forfeited.committed};
  }

  const playerProfile=await profileFor(uid);
  const proposedCode=roomCode();

  // Guardar primero el estado del jugador de forma directa. La transacción
  // anterior podía abortarse y luego responder "esperando" aunque no hubiera
  // persistido el listo.
  const now=Date.now();
  const cutoff=now-(10*60*1000);
  const latest=(await matchRef.get()).val();
  if(!latest || latest.winnerUid || !["ready","playing"].includes(latest.status)){
    throw new HttpsError("failed-precondition","Ese partido ya no está disponible.");
  }
  const readyUpdate={};
  for(const [playerUid,ready] of Object.entries(latest.readyPlayers||{})){
    if(Number(ready?.readyAt||0)<=cutoff) readyUpdate[`readyPlayers/${playerUid}`]=null;
  }
  readyUpdate[`readyPlayers/${uid}`]={
    uid,username:playerProfile.username,readyAt:now
  };
  await matchRef.update(readyUpdate);

  let match=(await matchRef.get()).val();
  if(!match || match.winnerUid){
    throw new HttpsError("failed-precondition","Ese partido ya no está disponible.");
  }
  const bothReady=Boolean(
    match.readyPlayers?.[match.playerAUid] &&
    match.readyPlayers?.[match.playerBUid]
  );
  if(!bothReady){
    const opponentName=match.playerAUid===uid?match.playerBName:match.playerAName;
    return {waiting:true,message:`Estás pronto. Esperando que ${opponentName||"tu rival"} entre al partido.`};
  }

  // Solo la reserva del código necesita transacción: si ambos jugadores llegan
  // al mismo tiempo, los dos reciben exactamente la misma sala.
  const codeTx=await matchRef.child("roomCode").transaction(current=>current||proposedCode);
  const reservedCode=codeTx.snapshot.val();
  if(!reservedCode) throw new HttpsError("internal","No se pudo reservar la sala.");
  await matchRef.update({
    status:"playing",
    startedAt:match.startedAt||Date.now()
  });
  match=(await matchRef.get()).val();

  const code=reservedCode;
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
  if(result?.forfeit===true){
    const ga=Number(result.goalsA), gb=Number(result.goalsB);
    return result.forfeitedBy &&
      [game.playerAUid,game.playerBUid].includes(result.forfeitedBy) &&
      ((ga===3&&gb===0&&result.winner==="A"&&result.forfeitedBy===game.playerBUid) ||
       (ga===0&&gb===3&&result.winner==="B"&&result.forfeitedBy===game.playerAUid));
  }
  /* Firebase puede serializar los planteles como arrays u objetos según
     sus índices. El resultado se valida contra el marcador autoritativo
     del mini partido, no contra la forma de serialización del plantel. */
  const ga=Number(result?.goalsA), gb=Number(result?.goalsB);
  if(!Number.isInteger(ga)||!Number.isInteger(gb)||ga<0||gb<0||ga>20||gb>20) return false;
  if(result?.fromMiniMatch!==true || !game.miniMatch) return false;
  const expected=ga>gb?"A":gb>ga?"B":"DRAW";
  return result.winner===expected;
}
async function applyUserResult(uid,room,entry,outcome,goalsFor,goalsAgainst){
  const userRef=db.ref(`users/${uid}`);
  const userSnap=await userRef.get();
  if(!userSnap.exists()) throw new Error(`No existe el usuario ${uid}`);

  // El historial se escribe siempre de forma directa para poder reparar
  // una ficha faltante aunque las estadísticas ya estuvieran aplicadas.
  await userRef.child(`history/${room}`).set(entry);

  // La marca por partido se reclama atómicamente. Solo quien la crea suma
  // estadísticas; trigger y sincronización pueden ejecutarse juntos sin duplicar.
  const claim=await userRef.child(`appliedMatches/${room}`).transaction(
    current=>current===true?undefined:true
  );
  if(!claim.committed) return;

  const updates={
    "stats/played":ServerValue.increment(1),
    "stats/goalsFor":ServerValue.increment(goalsFor),
    "stats/goalsAgainst":ServerValue.increment(goalsAgainst)
  };
  if(outcome==="win") updates["stats/won"]=ServerValue.increment(1);
  else if(outcome==="loss") updates["stats/lost"]=ServerValue.increment(1);
  else updates["stats/drawn"]=ServerValue.increment(1);
  await userRef.update(updates);
}
async function advanceTournament(game,result,winnerUid,winnerName){
  if(!game.tournamentId || !game.tournamentMatchId) return;
  const tournamentRef=db.ref(`tournaments/${game.tournamentId}`);
  const advanced=await tournamentRef.transaction(t=>{
    const match=t?.matches?.[game.tournamentMatchId];
    if(!match) return t;
    if(match.winnerUid){
      match.roomCode=null;
      delete match.readyPlayers;
      if(game.tournamentMatchId!=="final"){
        const finalMatch={...(t.matches.final||{}),label:"FINAL",status:"pending"};
        if(game.tournamentMatchId==="semifinal1"){
          finalMatch.playerAUid=match.winnerUid;
          finalMatch.playerAName=match.winnerName;
        }else{
          finalMatch.playerBUid=match.winnerUid;
          finalMatch.playerBName=match.winnerName;
        }
        const s1=t.matches.semifinal1, s2=t.matches.semifinal2;
        if(s1?.winnerUid&&s2?.winnerUid){
          t.status="final";
          finalMatch.status="ready";
        }
        t.matches.final=finalMatch;
      }
      return t;
    }
    if(!winnerUid){
      match.status="ready"; match.roomCode=null; delete match.readyPlayers;
      match.draws=Number(match.draws||0)+1;
      return t;
    }
    match.winnerUid=winnerUid;match.winnerName=winnerName;match.status="completed";
    match.score={A:result.goalsA,B:result.goalsB};
    match.roomCode=null;
    delete match.readyPlayers;
    if(game.tournamentMatchId==="final"){
      t.status="completed";t.winnerUid=winnerUid;t.winnerName=winnerName;t.finishedAt=Date.now();
    }else{
      const finalMatch={...(t.matches.final||{}),label:"FINAL",status:"pending"};
      if(game.tournamentMatchId==="semifinal1"){
        finalMatch.playerAUid=winnerUid;
        finalMatch.playerAName=winnerName;
      }else{
        finalMatch.playerBUid=winnerUid;
        finalMatch.playerBName=winnerName;
      }
      const s1=t.matches.semifinal1, s2=t.matches.semifinal2;
      if(s1?.winnerUid&&s2?.winnerUid){
        t.status="final";
        finalMatch.status="ready";
      }
      t.matches.final=finalMatch;
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

async function processOfficialGame(room,game,result){
  if(!validOfficialResult(game,result)){
    console.warn("Resultado rechazado",room);
    return {processed:false,reason:"invalid-result"};
  }

  const matchKey=cleanText(game.matchInstanceId,120)||room;
  const matchRef=db.ref(`matches/${matchKey}`);
  const created=await matchRef.transaction(current=>current||{
    roomCode:room,matchInstanceId:matchKey,playerAUid:game.playerAUid,playerBUid:game.playerBUid,
    playerAName:game.playerAName||"Equipo Azul",playerBName:game.playerBName||"Equipo Rojo",
    goalsA:result.goalsA,goalsB:result.goalsB,winner:result.winner,
    tournamentId:game.tournamentId||null,tournamentMatchId:game.tournamentMatchId||null,
    finishedAt:Date.now()
  });
  // applyUserResult es idempotente: se ejecuta también si el partido ya
  // estaba marcado como procesado para reparar historiales incompletos.
  const aWin=result.winner==="A", bWin=result.winner==="B";
  const common={finishedAt:Date.now(),tournamentId:game.tournamentId||null};
  const tournamentName=game.tournamentId?
    (await db.ref(`tournaments/${game.tournamentId}/name`).get()).val():null;

  await Promise.all([
    applyUserResult(game.playerAUid,matchKey,{...common,roomCode:room,tournamentName,opponentUid:game.playerBUid,opponentName:game.playerBName||"Equipo Rojo",myGoals:result.goalsA,opponentGoals:result.goalsB,outcome:aWin?"win":bWin?"loss":"draw"},aWin?"win":bWin?"loss":"draw",result.goalsA,result.goalsB),
    applyUserResult(game.playerBUid,matchKey,{...common,roomCode:room,tournamentName,opponentUid:game.playerAUid,opponentName:game.playerAName||"Equipo Azul",myGoals:result.goalsB,opponentGoals:result.goalsA,outcome:bWin?"win":aWin?"loss":"draw"},bWin?"win":aWin?"loss":"draw",result.goalsB,result.goalsA)
  ]);

  const winnerUid=aWin?game.playerAUid:bWin?game.playerBUid:null;
  const winnerName=aWin?(game.playerAName||"Equipo Azul"):bWin?(game.playerBName||"Equipo Rojo"):null;
  await advanceTournament(game,result,winnerUid,winnerName);
  await matchRef.child("processed").set(true);
  return {processed:true};
}

exports.recordOfficialResult=onValueCreated("/games/{room}/result",async event=>{
  const room=event.params.room, result=event.data.val();
  const game=(await event.data.ref.parent.get()).val();
  await processOfficialGame(room,game,result);
});


import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile,
  setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import { getDatabase, ref, get, set, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-functions.js";

let profile=null, auth=null, db=null, functions=null, stopUser=null, stopTournaments=null;
let callbacks={};
let tournamentRoomOpening="";
let tournamentRoomPromise=null;

async function openTournamentRoomOnce(code){
  if(!code) return;
  if(tournamentRoomOpening===code && tournamentRoomPromise) return tournamentRoomPromise;
  tournamentRoomOpening=code;
  tournamentRoomPromise=(async()=>{
    let lastError;
    for(let attempt=0;attempt<6;attempt++){
      try{
        await callbacks.onTournamentRoom?.(code);
        return;
      }catch(error){
        lastError=error;
        await new Promise(resolve=>setTimeout(resolve,500));
      }
    }
    tournamentRoomOpening="";
    tournamentRoomPromise=null;
    throw lastError||new Error("No se pudo abrir el partido.");
  })();
  return tournamentRoomPromise;
}

export function getV2Profile(){ return profile; }
export async function forfeitTournamentMatch(tournamentId,matchId){
  if(!functions || !tournamentId || !matchId) return;
  return httpsCallable(functions,"openTournamentMatch")({tournamentId,matchId,action:"forfeit"});
}

function el(id){ return document.getElementById(id); }
function finishBootLoading(){
  document.body.classList.remove("auth-loading");
  const loader=el("appBootLoader");
  if(loader) loader.setAttribute("aria-hidden","true");
}
function esc(value=""){ return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function usernameKey(value=""){ return value.trim().toLowerCase(); }
function validUsername(value=""){ return /^[a-zA-Z0-9_]{3,16}$/.test(value.trim()); }
function configured(config){ return config?.apiKey && !String(config.apiKey).startsWith("PEGAR_"); }
function authError(error){
  const map={
    "auth/email-already-in-use":"Ese correo ya está registrado.",
    "auth/invalid-credential":"Correo o contraseña incorrectos.",
    "auth/invalid-email":"El correo no es válido.",
    "auth/weak-password":"La contraseña debe tener al menos 6 caracteres.",
    "auth/too-many-requests":"Demasiados intentos. Probá nuevamente más tarde."
  };
  return map[error?.code] || error?.message || "No se pudo completar la operación.";
}
function setMessage(text="",error=false){ const node=el("authMessage"); if(node){node.textContent=text;node.className="auth-message"+(error?" error":"");} }
function showGate(mode="login"){
  finishBootLoading();
  document.body.classList.add("in-lobby");
  el("accountGate")?.classList.remove("screen-hidden");
  el("lobbyScreen")?.classList.add("screen-hidden");
  el("gameScreen")?.classList.add("screen-hidden");
  document.querySelectorAll(".auth-form").forEach(x=>x.classList.add("screen-hidden"));
  document.querySelectorAll(".auth-tab").forEach(x=>x.classList.remove("active"));
  el(mode==="register"?"registerForm":mode==="profile"?"finishProfileForm":"loginForm")?.classList.remove("screen-hidden");
  el(mode==="register"?"registerTab":"loginTab")?.classList.add("active");
  setMessage("");
}
function showLobby(){
  finishBootLoading();
  document.body.classList.add("in-lobby");
  el("accountGate")?.classList.add("screen-hidden");
  el("lobbyScreen")?.classList.remove("screen-hidden");
}
function injectUI(){
  const app=document.querySelector(".app"), lobby=el("lobbyScreen"), card=lobby?.querySelector(".lobby-card");
  if(!app || !card || el("accountGate")) return;
  const gate=document.createElement("section");
  gate.id="accountGate"; gate.className="account-gate";
  gate.innerHTML=`
    <div class="account-card">
      <div class="account-brand"><h2>Tu cuenta de jugador</h2><p>Guardá tus estadísticas, rivales y torneos en todos tus dispositivos.</p></div>
      <div class="auth-tabs"><button id="loginTab" class="auth-tab active">INGRESAR</button><button id="registerTab" class="auth-tab">CREAR CUENTA</button></div>
      <form id="loginForm" class="auth-form">
        <label>USUARIO O CORREO</label><input id="loginEmail" class="auth-input" type="text" autocomplete="username" placeholder="Tu usuario o correo" required>
        <label>CONTRASEÑA</label><input id="loginPassword" class="auth-input" type="password" autocomplete="current-password" required>
        <button class="lobby-button" type="submit">INGRESAR</button><button id="resetPassword" class="auth-help" type="button">Olvidé mi contraseña</button>
      </form>
      <form id="registerForm" class="auth-form screen-hidden">
        <label>NOMBRE DE USUARIO ÚNICO</label><input id="registerUsername" class="auth-input" maxlength="16" placeholder="Ej: Matias10" required>
        <label>CORREO</label><input id="registerEmail" class="auth-input" type="email" autocomplete="email" required>
        <label>CONTRASEÑA</label><input id="registerPassword" class="auth-input" type="password" minlength="6" autocomplete="new-password" required>
        <label>REPETIR CONTRASEÑA</label><input id="registerPassword2" class="auth-input" type="password" minlength="6" autocomplete="new-password" required>
        <button class="lobby-button" type="submit">CREAR MI CUENTA</button>
      </form>
      <form id="finishProfileForm" class="auth-form screen-hidden">
        <div class="v2-notice">Tu cuenta existe, pero falta elegir un nombre único para entrar al juego.</div>
        <label>NOMBRE DE USUARIO</label><input id="finishUsername" class="auth-input" maxlength="16" required>
        <button class="lobby-button" type="submit">GUARDAR Y CONTINUAR</button>
      </form>
      <div id="authMessage" class="auth-message"></div>
    </div>`;
  app.insertBefore(gate,lobby);

  const old=[...card.children];
  const play=document.createElement("div"); play.id="playPanel"; play.className="account-panel active";
  old.forEach(node=>play.appendChild(node));
  card.innerHTML=`
    <div class="user-bar"><div class="user-identity"><strong id="currentUsername">Jugador</strong><small id="quickRecord">0 PJ · 0 PG</small></div><button id="logoutButton" class="user-logout">SALIR</button></div>
    <div class="dashboard-tabs">
      <button class="dashboard-tab active" data-panel="playPanel">JUGAR</button>
      <button class="dashboard-tab" data-panel="profilePanel">PERFIL</button>
      <button class="dashboard-tab" data-panel="historyPanel">HISTORIAL</button>
      <button class="dashboard-tab" data-panel="tournamentsPanel">TORNEOS</button>
    </div>`;
  card.appendChild(play);
  for(const [id,title,subtitle] of [
    ["profilePanel","Mi perfil","Tus números se actualizan cuando termina cada partido."],
    ["historyPanel","Historial","Resultados guardados y enfrentamientos entre jugadores."],
    ["tournamentsPanel","Torneos de 4","Creá un torneo o sumate hasta completar dos semifinales."]
  ]){
    const panel=document.createElement("div"); panel.id=id; panel.className="account-panel";
    panel.innerHTML=`<h2 class="panel-title">${title}</h2><p class="panel-subtitle">${subtitle}</p><div id="${id}Content"></div>`;
    card.appendChild(panel);
  }
}
async function claimUsername(user,value){
  const username=value.trim();
  if(!validUsername(username)) throw new Error("Usá entre 3 y 16 letras, números o guion bajo.");
  const key=usernameKey(username);
  const claim=await runTransaction(ref(db,`usernames/${key}`),current=>current===null?user.uid:current,{applyLocally:false});
  if(!claim.committed || claim.snapshot.val()!==user.uid) throw new Error("Ese nombre de usuario ya está ocupado.");
  const existing=(await get(ref(db,`users/${user.uid}/profile`))).val();
  if(existing?.usernameKey && existing.usernameKey!==key) throw new Error("El nombre de usuario no puede cambiarse.");
  const newProfile={username,usernameKey:key,email:user.email||"",createdAt:existing?.createdAt||Date.now()};
  await set(ref(db,`users/${user.uid}/profile`),newProfile);
  await updateProfile(user,{displayName:username});
  return newProfile;
}
function switchPanel(id){
  document.querySelectorAll(".account-panel").forEach(x=>x.classList.toggle("active",x.id===id));
  document.querySelectorAll(".dashboard-tab").forEach(x=>x.classList.toggle("active",x.dataset.panel===id));
}
function statsOf(data){ return {played:0,won:0,drawn:0,lost:0,goalsFor:0,goalsAgainst:0,tournamentsWon:0,...(data||{})}; }
function renderProfile(userData={}){
  const p=userData.profile||profile||{}, s=statsOf(userData.stats);
  profile=p;
  if(el("currentUsername")) el("currentUsername").textContent=p.username||"Jugador";
  if(el("quickRecord")) el("quickRecord").textContent=`${s.played} PJ · ${s.won} PG`;
  const points=s.won*3+s.drawn, avg=s.played?(s.goalsFor/s.played).toFixed(1):"0.0";
  if(el("profilePanelContent")) el("profilePanelContent").innerHTML=`
    <div class="profile-hero"><strong>@${esc(p.username||"jugador")}</strong><span>${esc(p.email||"")}</span></div>
    <div class="profile-stats">
      <div class="profile-stat"><strong>${s.played}</strong><span>PARTIDOS</span></div>
      <div class="profile-stat"><strong>${s.won}</strong><span>GANADOS</span></div>
      <div class="profile-stat"><strong>${s.drawn}</strong><span>EMPATES</span></div>
      <div class="profile-stat"><strong>${s.lost}</strong><span>PERDIDOS</span></div>
      <div class="profile-stat"><strong>${points}</strong><span>PUNTOS</span></div>
      <div class="profile-stat"><strong>${avg}</strong><span>GOLES/PARTIDO</span></div>
      <div class="profile-stat tournament-stat"><strong>🏆 ${s.tournamentsWon}</strong><span>TORNEOS GANADOS</span></div>
    </div>`;
  renderHistory(userData.history||{},s);
}
function renderHistory(history,stats={}){
  const node=el("historyPanelContent"); if(!node) return;
  const items=Object.values(history||{}).sort((a,b)=>(b.finishedAt||0)-(a.finishedAt||0));
  const trophy=`<div class="tournament-wins-summary"><span>🏆</span><div><strong>${Number(stats.tournamentsWon||0)}</strong><small>TORNEOS GANADOS</small></div></div>`;
  if(!items.length){node.innerHTML=trophy+'<div class="empty-state">Todavía no jugaste partidos registrados.</div>';return;}
  node.innerHTML=trophy+'<div class="history-list">'+items.map(m=>{
    const cls=m.outcome==="win"?"outcome-win":m.outcome==="loss"?"outcome-loss":"outcome-draw";
    const label=m.outcome==="win"?"VICTORIA":m.outcome==="loss"?"DERROTA":"EMPATE";
    return `<div class="history-item"><div class="history-row"><div><strong>vs ${esc(m.opponentName||"Rival")}</strong><div class="item-meta">${new Date(m.finishedAt||Date.now()).toLocaleDateString("es-UY")}${m.tournamentName?" · "+esc(m.tournamentName):""}</div></div><div style="text-align:right"><div class="history-score">${m.myGoals} - ${m.opponentGoals}</div><small class="${cls}">${label}</small></div></div></div>`;
  }).join("")+"</div>";
}
function renderTournaments(data={}){
  const node=el("tournamentsPanelContent"); if(!node) return;
  const list=Object.entries(data).sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0));
  node.innerHTML=`<div class="tournament-create"><input id="tournamentName" class="auth-input" maxlength="28" placeholder="Nombre del torneo"><button id="createTournamentButton" class="small-action green">CREAR</button></div><div id="tournamentMessage" class="auth-message"></div><div class="tournament-list">${list.length?list.map(([id,t])=>tournamentCard(id,t)).join(""):'<div class="empty-state">No hay torneos todavía. Creá el primero.</div>'}</div>`;
  const currentUid=auth.currentUser?.uid;
  for(const [tournamentId,tournament] of Object.entries(data||{})){
    for(const [matchId,match] of Object.entries(tournament?.matches||{})){
      const mine=match?.playerAUid===currentUid || match?.playerBUid===currentUid;
      if(match?.status==="playing" && match.roomCode && !match.winnerUid && mine &&
         match.readyPlayers?.[currentUid] && tournamentRoomOpening!==match.roomCode){
        queueMicrotask(()=>openTournamentRoomOnce(match.roomCode).catch(error=>console.error("No se pudo abrir el partido del torneo:",error)));
        return;
      }
    }
  }
}
function bracketPlayer(name,fallback="Por definir"){
  return `<span class="bracket-player">${esc(name||fallback)}</span>`;
}
function bracketMatch(tournamentId,matchId,match){
  const m=match||{};
  const currentUid=auth.currentUser?.uid;
  const mine=m.playerAUid===currentUid||m.playerBUid===currentUid;
  const readyPlayers=m.readyPlayers||{};
  const mineReady=Boolean(readyPlayers[currentUid]);
  const opponentUid=m.playerAUid===currentUid?m.playerBUid:m.playerAUid;
  const opponentReady=Boolean(readyPlayers[opponentUid]);
  const readyNames=Object.values(readyPlayers).map(player=>player?.username).filter(Boolean);
  const canOpen=mine && m.status==="ready" && !m.winnerUid && !mineReady;
  const canReenter=mine && m.status==="playing" && Boolean(m.roomCode) && !m.winnerUid;
  const hasScore=m.score && Number.isFinite(Number(m.score.A)) && Number.isFinite(Number(m.score.B));
  const status=m.winnerUid?"FINALIZADO":m.status==="playing"?"EN JUEGO":readyNames.length?"ESPERANDO RIVAL":"LISTO";
  const readyNotice=readyNames.length
    ? `<div class="item-meta" style="margin:8px 0;color:#baff42">${readyNames.map(name=>esc(name)).join(" y ")} ${readyNames.length===1?"está pronto para jugar":"están prontos para jugar"}</div>`
    : "";
  const buttonText=canReenter?"ENTRAR AL PARTIDO":opponentReady?`${esc(readyPlayers[opponentUid]?.username||"Tu rival")} ESTÁ PRONTO · JUGAR`:"JUGAR";
  return `<div class="elimination-match ${m.winnerUid?"completed":""}">
    <div class="elimination-status">${status}</div>
    <div class="bracket-player-row ${m.winnerUid===m.playerAUid?"winner":""}">${bracketPlayer(m.playerAName)}<strong>${hasScore?m.score.A:"–"}</strong></div>
    <div class="bracket-player-row ${m.winnerUid===m.playerBUid?"winner":""}">${bracketPlayer(m.playerBName)}<strong>${hasScore?m.score.B:"–"}</strong></div>
    ${readyNotice}
    ${canOpen||canReenter?`<button class="small-action bracket-play" data-open-tournament="${esc(tournamentId)}" data-match="${esc(matchId)}">${buttonText}</button>`:mineReady&&m.status==="ready"?`<button class="small-action danger" data-cancel-ready="${esc(tournamentId)}" data-match="${esc(matchId)}">CANCELAR ESPERA</button>`:""}
  </div>`;
}
function tournamentBracket(id,t){
  const matches=t.matches||{};
  return `<div class="fixture-title">CUADRO DE ELIMINACIÓN</div>
    <div class="elimination-bracket">
      <div class="bracket-round semifinal-round">
        <div class="round-label">SEMIFINALES</div>
        ${bracketMatch(id,"semifinal1",matches.semifinal1)}
        ${bracketMatch(id,"semifinal2",matches.semifinal2)}
      </div>
      <div class="bracket-path" aria-hidden="true"><i class="path-top"></i><i class="path-bottom"></i><i class="path-middle"></i></div>
      <div class="bracket-round final-round">
        <div class="trophy-wrap"><span class="rotating-trophy">🏆</span></div>
        <div class="round-label">FINAL</div>
        ${bracketMatch(id,"final",matches.final)}
      </div>
    </div>`;
}
function tournamentCard(id,t){
  const participants=Object.values(t.participants||{}), joined=participants.some(p=>p.uid===auth.currentUser?.uid), isOwner=t.ownerUid===auth.currentUser?.uid;
  const status={waiting:"ESPERANDO",semifinals:"SEMIFINALES",final:"FINAL",completed:"FINALIZADO"}[t.status]||"TORNEO";
  const waitingSlots=t.status==="waiting"?`<div class="waiting-slots">${[0,1,2,3].map((_,index)=>{
    const player=participants[index];
    return `<div class="waiting-slot ${player?"filled":""}"><span>${index+1}</span>${esc(player?.username||"Lugar disponible")}</div>`;
  }).join("")}</div>`:"";
  return `<div class="tournament-item tournament-fixture">
    <div class="tournament-row">
      <div><strong class="tournament-name">${esc(t.name||"Torneo")}</strong><div class="item-meta">${status} · ${participants.length}/4 jugadores</div></div>
      <div class="tournament-actions">${t.status==="waiting"&&!joined?`<button class="small-action" data-join-tournament="${esc(id)}">UNIRME</button>`:""}${isOwner?`<button class="small-action danger" data-delete-tournament="${esc(id)}" title="Eliminar torneo">ELIMINAR</button>`:""}</div>
    </div>
    ${waitingSlots}
    ${t.matches?tournamentBracket(id,t):""}
    ${t.winnerName?`<div class="champion-banner"><span class="rotating-trophy">🏆</span><div><small>CAMPEÓN</small><strong>${esc(t.winnerName)}</strong></div></div>`:""}
  </div>`;
}

function startUserData(uid){
  if(stopUser) stopUser();
  stopUser=onValue(ref(db,`users/${uid}`),snap=>renderProfile(snap.val()||{}));
  if(stopTournaments) stopTournaments();
  stopTournaments=onValue(ref(db,"tournaments"),snap=>renderTournaments(snap.val()||{}));
}
async function finishLogin(user){
  const snap=await get(ref(db,`users/${user.uid}/profile`));
  if(!snap.exists()){ showGate("profile"); return; }
  profile=snap.val(); startUserData(user.uid); showLobby();
  await callbacks.onReady?.({app:auth.app,auth,db,user,profile});
}
function bindUI(){
  el("loginTab").onclick=()=>showGate("login"); el("registerTab").onclick=()=>showGate("register");
  document.querySelectorAll(".dashboard-tab").forEach(b=>b.onclick=()=>switchPanel(b.dataset.panel));
  el("loginForm").onsubmit=async e=>{
    e.preventDefault();
    const identifier=el("loginEmail").value.trim();
    setMessage("Ingresando...");
    try{
      localStorage.setItem("ofertasV2LastLogin",identifier);
      let email=identifier;
      if(!identifier.includes("@")){
        const resolved=await httpsCallable(functions,"resolveLoginEmail")({identifier});
        email=resolved.data.email;
      }
      await signInWithEmailAndPassword(auth,email,el("loginPassword").value);
    }catch(err){setMessage(authError(err),true);}
  };
  el("registerForm").onsubmit=async e=>{e.preventDefault();const pass=el("registerPassword").value;if(pass!==el("registerPassword2").value)return setMessage("Las contraseñas no coinciden.",true);try{setMessage("Creando cuenta...");const cred=await createUserWithEmailAndPassword(auth,el("registerEmail").value.trim(),pass);await claimUsername(cred.user,el("registerUsername").value);await finishLogin(cred.user);}catch(err){setMessage(authError(err),true);}};
  el("finishProfileForm").onsubmit=async e=>{e.preventDefault();try{setMessage("Guardando nombre...");await claimUsername(auth.currentUser,el("finishUsername").value);await finishLogin(auth.currentUser);}catch(err){setMessage(authError(err),true);}};
  el("resetPassword").onclick=async()=>{const email=el("loginEmail").value.trim();if(!email)return setMessage("Escribí tu correo primero.",true);try{await sendPasswordResetEmail(auth,email);setMessage("Te enviamos un correo para cambiar la contraseña.");}catch(err){setMessage(authError(err),true);}};
  el("logoutButton").onclick=()=>signOut(auth);
  el("tournamentsPanelContent").addEventListener("click",async e=>{
    const create=e.target.closest("#createTournamentButton"), join=e.target.closest("[data-join-tournament]"), open=e.target.closest("[data-open-tournament]"), cancelReady=e.target.closest("[data-cancel-ready]"), remove=e.target.closest("[data-delete-tournament]");
    const msg=el("tournamentMessage");
    if(msg) msg.className="auth-message";
    try{
      if(create){const name=el("tournamentName").value.trim();if(name.length<3)throw new Error("Escribí un nombre para el torneo.");msg.textContent="Creando torneo...";await httpsCallable(functions,"createTournament")({name});}
      if(join){msg.textContent="Uniéndote...";await httpsCallable(functions,"joinTournament")({tournamentId:join.dataset.joinTournament});}
      if(cancelReady){
        if(!confirm("¿Cancelar la espera? Los dos jugadores dejarán de figurar como prontos.")) return;
        msg.textContent="Cancelando espera...";
        await httpsCallable(functions,"openTournamentMatch")({
          tournamentId:cancelReady.dataset.cancelReady,
          matchId:cancelReady.dataset.match,
          action:"cancelReady"
        });
        tournamentRoomOpening="";
        tournamentRoomPromise=null;
      }
      if(open){
        msg.textContent="Marcándote como pronto...";
        const result=await httpsCallable(functions,"openTournamentMatch")({tournamentId:open.dataset.openTournament,matchId:open.dataset.match});
        if(result.data.roomCode){
          await openTournamentRoomOnce(result.data.roomCode);
        }else{
          msg.textContent=result.data.message||"Estás pronto. Esperando que entre tu rival...";
          return;
        }
      }
      if(remove){
        const card=remove.closest(".tournament-item"), name=card?.querySelector(".tournament-name")?.textContent||"este torneo";
        if(!confirm(`¿Eliminar definitivamente “${name}”?\n\nSe cerrarán sus partidos abiertos y esta acción no se puede deshacer.`)) return;
        remove.disabled=true; msg.textContent="Eliminando torneo...";
        await httpsCallable(functions,"deleteTournament")({tournamentId:remove.dataset.deleteTournament});
      }
      if(msg) msg.textContent="";
    }catch(err){if(msg){msg.textContent=err?.message||"No se pudo completar la acción.";msg.className="auth-message error";}}
  });
}
export async function startV2App(config,handlers={}){
  callbacks=handlers; injectUI();
  if(!configured(config)){bindUI();showGate("login");setMessage("Falta configurar el nuevo proyecto Firebase en firebase-config.js.",true);return;}
  const app=initializeApp(config); auth=getAuth(app); db=getDatabase(app); functions=getFunctions(app);
  auth.languageCode="es";
  await setPersistence(auth,browserLocalPersistence);
  bindUI();
  const remembered=localStorage.getItem("ofertasV2LastLogin");
  if(remembered && el("loginEmail")) el("loginEmail").value=remembered;
  onAuthStateChanged(auth,async user=>{
    if(user){
      try{
        await finishLogin(user);
        // Repara resultados válidos que hayan quedado sin procesar por una
        // interrupción del trigger. El servidor evita contabilizarlos dos veces.
        httpsCallable(functions,"openTournamentMatch")({action:"syncResults"}).catch(error=>
          console.warn("No se pudieron sincronizar resultados pendientes:",error)
        );
      }catch(err){showGate("login");setMessage(authError(err),true);}
    }
    else{profile=null;if(stopUser)stopUser();if(stopTournaments)stopTournaments();showGate("login");callbacks.onSignedOut?.();}
  });
}

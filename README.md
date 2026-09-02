# Mercado Élite 5 — ofertas-v2

Nueva versión con cuentas persistentes, nombres únicos, estadísticas, historial entre jugadores y torneos de cuatro participantes.

## Configuración inicial

1. Creá un proyecto nuevo en [Firebase Console](https://console.firebase.google.com/).
2. Agregá una app Web y copiá sus datos en `firebase-config.js`.
3. En Authentication > Sign-in method, habilitá **Correo electrónico/contraseña**.
4. Creá Realtime Database en una región cercana a tus jugadores.
5. En Firebase Console > Configuración del proyecto > General, copiá el ID del proyecto y reemplazá `PEGAR_PROJECT_ID` en `.firebaserc`.
6. Instalá Node.js 20 y Firebase CLI.
7. Desde la carpeta del repositorio ejecutá:

```bash
npm install -g firebase-tools
firebase login
firebase use --add
cd functions
npm install
cd ..
firebase deploy
```

El comando publica las reglas, las funciones seguras y el sitio.

## Datos principales

- `usernames`: reserva atómica de nombres únicos.
- `users/{uid}/profile`: perfil del jugador.
- `users/{uid}/stats`: estadísticas escritas únicamente por el servidor.
- `users/{uid}/history`: historial privado del jugador.
- `games`: estado temporal de partidas.
- `openRooms`: mesas públicas y presencia de espectadores.
- `matches`: resultados oficiales inmutables.
- `tournaments`: cuadros de cuatro jugadores.

## Seguridad

El navegador puede jugar partidas, pero no puede editar estadísticas, historiales, resultados oficiales ni torneos. La Cloud Function `recordOfficialResult` comprueba participantes, planteles completos, marcador y estado final del mini partido antes de registrar el resultado.

Esta primera capa evita modificar directamente las estadísticas. Para competición con premios o anti-trampas estricto, el siguiente paso es mover también cada oferta y cada elección del mini partido a funciones del servidor.

## Desarrollo local

Serví la raíz con un servidor HTTP; los módulos ES no funcionan correctamente abriendo `index.html` como archivo local.

```bash
firebase emulators:start
```

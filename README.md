# Robot Arena

A small multiplayer FPS wave-defense game. Express + `ws` on the server, Three.js + Rapier3D on the client.

## Run it

Requires Node.js (18+ recommended).

```sh
npm install      # first time only
npm start        # or: node server.js
```

Server listens on `http://localhost:3000`. Open that URL in a browser, pick a name and room code, and click **Start mission**. Share the same room code (or the `Copy invite` link) with friends to play together.

## Restarting after server changes

`node` does not hot-reload — if you edit `server.js` (e.g. the `WALLS` layout) you have to stop the running process (Ctrl+C) and start it again with `npm start`. Then reload the browser and start a new mission so it picks up the fresh map.

## Sharing over the internet (Cloudflare quick tunnel)

To let friends join from outside your network without opening ports, expose the local server with a Cloudflare quick tunnel. Requires [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) on `PATH`.

```sh
cloudflared tunnel --url http://localhost:3000
```

It prints a fresh URL like `https://<random-words>.trycloudflare.com` — share that (optionally append `?room=<code>` to drop straight into a room).

Caveats:

- Each invocation mints a new random hostname; the URL **dies when the `cloudflared` process exits**. Don't bookmark it for the long term.
- For a stable URL, switch to a *named* tunnel (`cloudflared login`, `cloudflared tunnel create <name>`, point a CNAME at it, `cloudflared tunnel run <name>`). Requires a Cloudflare-managed domain.

## Layout

- `server.js` — game loop, WebSocket protocol, bot AI, level data (`WALLS`).
- `public/index.html` — single-file client (rendering, physics, UI).

## Controls

WASD move · Shift sprint · Space jump · Mouse aim · LMB shoot · R reload · G grenade · T chat · Tab scoreboard · **O** open the in-game graphics / sensitivity panel.

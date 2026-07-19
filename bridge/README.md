# Feed Goblin — remote-control bridge

Optional local helper that lets any HTTP client — a **Stream Deck**, Home
Assistant, a script — control the extension while another window (a game) is
focused, without switching to Chrome.

It is a tiny HTTP → WebSocket relay. It **launches no browser** and connects to
**nothing off your machine**: both servers bind to `127.0.0.1`, and every
command must carry a shared token.

```
HTTP client (Stream Deck, Home Assistant, script…) ──▶ bridge (127.0.0.1:8787) ──▶ extension (WebSocket) ──▶ live feed
```

## Endpoints

| Endpoint | Action |
|----------|--------|
| `GET /audio/left`   | isolate left-channel camera |
| `GET /audio/center` | normal stereo (both) |
| `GET /audio/right`  | isolate right-channel camera |
| `GET /fullscreen`   | toggle the feed window fullscreen (F11-style) |

`/fullscreen` toggles the whole **browser window** in and out of fullscreen —
not the video element. The video element's own fullscreen needs a real user
gesture, which a background command can't provide; the window toggle has no such
limit, so it works while another app is focused. (Camera-switch endpoints come
next.)

## Setup

1. **Install deps** (Node 18+; you have v24):
   ```
   cd bridge
   npm install
   ```
2. **Run it:**
   ```
   npm start
   ```
   On first run it creates `config.json` with a random **token** and prints it.
   Copy that token.
3. **Turn the feature on** in the extension: click the extension icon → open
   **Advanced** → check **Remote control (local API)**. (Off by default.)
4. **Point your client at the endpoints** — e.g. a Stream Deck via BarRaider's
   API Ninja, a Home Assistant REST command, or `curl`. One call per audio mode:
   - Method: `GET`
   - URL: `http://127.0.0.1:8787/audio/left` (and `/center`, `/right`)
   - Header: `X-Feed-Token` = *the token from step 2*

That's it. Open the quad-cam feed, start playback (this "arms" the audio once —
a browser requirement), then tab away to your game and switch L/C/R from your
client (Stream Deck, Home Assistant, a script, etc.).

## Notes

- **Token lives only here** (`config.json`, gitignored). To rotate it, delete
  `config.json` and restart — then update the header in your client (e.g. API Ninja).
- **Port** defaults to `8787`. To change it, edit `port` in `config.json` **and**
  set the matching **Bridge port** in the extension popup (shown when Remote
  control is on). Both sides must agree. No manifest edit is needed — the
  extension is allowed to reach any port on `127.0.0.1`.
- **Audio "arming":** Chrome won't start the audio engine from a background
  command, so play the feed once with the tab focused at the start of a session.
  After that, remote L/C/R switching works while backgrounded.
- Requests without the correct `X-Feed-Token` header get `401`. A command that
  arrives while no extension is connected gets `503`.

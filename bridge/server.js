// Local-only bridge between a Stream Deck (BarRaider API Ninja, which sends
// HTTP) and the Feed Goblin extension (which connects here over a
// WebSocket from your normal Chrome). It launches NO browser and talks to
// nothing off this machine: both the HTTP and WebSocket servers bind to
// 127.0.0.1 only, and every HTTP command must carry the shared token.
//
//   node server.js
'use strict';

// Name the process/console window so it's easy to spot and stop (otherwise it's
// an anonymous "node.exe"). Shows as the console title and in process tools.
process.title = 'Feed Goblin Bridge';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const HOST = '127.0.0.1';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const VALID_MODES = new Set(['left', 'center', 'right']);

// Load or (first run) generate the config. config.json is gitignored so the
// token never leaves this machine.
function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  const cfg = { port: 8787, token: crypto.randomBytes(24).toString('hex') };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log('Generated bridge/config.json with a fresh token.');
  return cfg;
}

const config = loadConfig();

// Connected extension service worker(s). Normally exactly one.
const clients = new Set();

function broadcast(obj) {
  const data = JSON.stringify(obj);
  let delivered = 0;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
      delivered++;
    }
  }
  return delivered;
}

const server = http.createServer((req, res) => {
  // Reject anything without the shared token. Requiring a CUSTOM header (not a
  // query param) forces a CORS preflight that a random webpage can't satisfy —
  // that's what actually blocks localhost-CSRF from a page you might visit.
  if (req.headers['x-feed-token'] !== config.token) {
    res.writeHead(401);
    res.end('unauthorized');
    return;
  }

  const url = new URL(req.url, `http://${HOST}`);

  const m = url.pathname.match(/^\/audio\/(left|center|right)$/);
  if (m && VALID_MODES.has(m[1])) {
    const delivered = broadcast({ type: 'command', action: 'audio', mode: m[1] });
    res.writeHead(delivered ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: delivered > 0, mode: m[1], clients: delivered }));
    return;
  }

  // Toggle the feed window between fullscreen and normal.
  if (url.pathname === '/fullscreen') {
    const delivered = broadcast({ type: 'command', action: 'fullscreen' });
    res.writeHead(delivered ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: delivered > 0, action: 'fullscreen', clients: delivered }));
    return;
  }

  // Navigate the Paramount+ app tab to Big Brother (used by the launcher).
  if (url.pathname === '/goto') {
    const delivered = broadcast({ type: 'command', action: 'goto' });
    res.writeHead(delivered ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: delivered > 0, action: 'goto', clients: delivered }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// Share the HTTP server, so the WebSocket also lives on the loopback-bound port.
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`extension connected (${clients.size} total)`);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// Keepalive: any inbound data frame resets the extension service worker's MV3
// idle timer, so a periodic ping keeps the worker — and this connection — alive.
setInterval(() => broadcast({ type: 'ping', t: Date.now() }), 20000);

// If the port is taken, the bridge is almost certainly already running (the
// launcher can fire this a second time). Exit cleanly instead of crashing.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} already in use — bridge likely already running. Exiting.`);
    process.exit(0);
  }
  throw err;
});

server.listen(config.port, HOST, () => {
  console.log(`Feed Goblin bridge on http://${HOST}:${config.port} (loopback only)`);
  console.log(`Token — put this in API Ninja's "X-Feed-Token" header:\n  ${config.token}`);
});

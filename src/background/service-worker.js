// Optional Stream Deck remote-control client. DORMANT unless the user turns on
// "Remote control" in the popup (storage flag `remoteEnabled`, default off).
//
// When on, it holds a WebSocket out to a local bridge (127.0.0.1:8787) that
// relays Stream Deck HTTP calls. The extension can't open a listening socket
// itself, so it connects OUT; the CSP (see manifest) also pins it to that one
// loopback address, so it can't phone anywhere else. Received commands are
// forwarded to the live-feed tab, which runs them through the same functions
// the on-page hotkeys use.
'use strict';

const DEFAULT_PORT = 8787;
const STREAM_URL_GLOB = 'https://www.paramountplus.com/live-tv/stream/big_brother/*';
const PARAMOUNT_GLOB = 'https://www.paramountplus.com/*';
const SHOW_URL = 'https://www.paramountplus.com/shows/big_brother/';
const RECONNECT_MS = 5000;
const KEEPALIVE_ALARM = 'feed-remote-keepalive';

let socket = null;
let reconnectTimer = null;

function isEnabled() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['remoteEnabled'], (r) => resolve(r.remoteEnabled === true));
  });
}

// User-configurable bridge port (popup), persisted in storage. Falls back to
// the default for anything missing or out of range. Host stays 127.0.0.1, and
// the manifest CSP only allows ws://127.0.0.1:* — so this can't point off-box.
function getPort() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['remotePort'], (r) => {
      const n = parseInt(r.remotePort, 10);
      resolve(n >= 1 && n <= 65535 ? n : DEFAULT_PORT);
    });
  });
}

async function connect() {
  if (!(await isEnabled())) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const port = await getPort();
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => console.log('[FeedGoblin] bridge connected');
  socket.onmessage = (ev) => {
    // Any inbound frame (including the bridge's keepalive ping) resets this
    // worker's MV3 idle timer — that's why the bridge pings periodically.
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg && msg.type === 'command') dispatch(msg);
  };
  socket.onclose = () => {
    socket = null;
    scheduleReconnect();
  };
  socket.onerror = () => {
    try {
      socket && socket.close();
    } catch (e) {
      /* ignore */
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (await isEnabled()) connect();
  }, RECONNECT_MS);
}

function disconnect() {
  if (socket) {
    try {
      socket.close();
    } catch (e) {
      /* ignore */
    }
    socket = null;
  }
}

// Relay a validated command. Audio goes to the page (same path the hotkeys
// use); fullscreen is handled here at the window level, because the video
// element's own fullscreen needs a real user gesture we can't fake from a
// background command — the browser-window toggle has no such requirement.
function dispatch(msg) {
  if (msg.action === 'fullscreen') {
    toggleFullscreen();
    return;
  }
  if (msg.action === 'goto') {
    gotoBigBrother();
    return;
  }
  chrome.tabs.query({ url: STREAM_URL_GLOB }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(
        tab.id,
        { type: 'remote-command', action: msg.action, mode: msg.mode },
        () => void chrome.runtime.lastError
      );
    }
  });
}

// Navigate the Paramount+ app tab to Big Brother — straight to the multiview if
// its link is cached (feedCameras), otherwise the show page (which re-caches it
// for next time). Skips if already there, so re-launching doesn't reload.
function gotoBigBrother() {
  chrome.storage.local.get(['feedCameras'], (res) => {
    const cams = res.feedCameras || [];
    const mv = cams.find((c) => /multi.?view/i.test(c.label || ''));
    const target = (mv && mv.href) || SHOW_URL;
    const norm = (u) => (u || '').split('?')[0].replace(/\/$/, '');
    chrome.tabs.query({ url: PARAMOUNT_GLOB }, (tabs) => {
      const tab = tabs[0];
      if (!tab) return;
      if (norm(tab.url) === norm(target)) return; // already there
      chrome.tabs.update(tab.id, { url: target }, () => void chrome.runtime.lastError);
    });
  });
}

// F11-style: flip the window holding the feed between fullscreen and normal,
// and tell the page to enter/leave "kiosk" mode (hides the page scrollbar) to
// match — so the scrollbar only disappears while actually watching fullscreen.
function toggleFullscreen() {
  chrome.tabs.query({ url: STREAM_URL_GLOB }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    chrome.windows.get(tab.windowId, (win) => {
      if (chrome.runtime.lastError || !win) return;
      const goFull = win.state !== 'fullscreen';
      chrome.windows.update(tab.windowId, { state: goFull ? 'fullscreen' : 'normal' }, () => void chrome.runtime.lastError);
      chrome.tabs.sendMessage(tab.id, { type: 'remote-command', action: 'kiosk', on: goFull }, () => void chrome.runtime.lastError);
    });
  });
}

// Connect / disconnect the moment the popup toggle changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('remoteEnabled' in changes) {
    if (changes.remoteEnabled.newValue === true) connect();
    else disconnect();
  }
  // Port changed in the popup: drop the old connection and reconnect on the new
  // one (connect() no-ops if remote control is off).
  if ('remotePort' in changes) {
    disconnect();
    connect();
  }
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Belt-and-suspenders: if the worker was torn down and revived without an
// inbound event, an alarm brings the connection back.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE_ALARM) connect();
});

// Attempt on load too (covers the normal worker-start path).
connect();

const SHOW_URL = 'https://www.paramountplus.com/shows/big_brother/';
const STREAM_MATCH = /paramountplus\.com\/live-tv\/stream\/big_brother\//i;
const STREAM_GLOB = 'https://www.paramountplus.com/live-tv/stream/big_brother/*';

const DEFAULT_PORT = 8787;

const enabledToggle = document.getElementById('enabledToggle');
const remoteToggle = document.getElementById('remoteToggle');
const portRow = document.getElementById('portRow');
const remotePort = document.getElementById('remotePort');
const customConfig = document.getElementById('customConfig');
const openFeedsBtn = document.getElementById('openFeeds');
const statusEl = document.getElementById('status');

// The feed often lives in a SEPARATE app window, so target feed tabs by URL
// across all windows — not just the active-current-window tab (which is why an
// earlier version's live updates silently did nothing).
function sendToFeeds(msg) {
  chrome.tabs.query({ url: STREAM_GLOB }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, msg, () => void chrome.runtime.lastError);
    }
  });
}

chrome.storage.local.get(['feedEnabled', 'remoteEnabled', 'remotePort', 'customConfig'], (res) => {
  enabledToggle.checked = res.feedEnabled !== false;
  remoteToggle.checked = res.remoteEnabled === true;
  remotePort.value = res.remotePort || DEFAULT_PORT;
  portRow.hidden = !remoteToggle.checked; // only show the port when remote is on
  customConfig.checked = res.customConfig === true;
});

// The service worker watches these flags and connects/disconnects the bridge
// WebSocket accordingly, so just writing storage is enough.
remoteToggle.addEventListener('change', () => {
  chrome.storage.local.set({ remoteEnabled: remoteToggle.checked });
  portRow.hidden = !remoteToggle.checked;
});

// Clamp to a valid port, fall back to the default, and persist. The service
// worker reconnects to the new port on this change.
function savePort() {
  let n = parseInt(remotePort.value, 10);
  if (!(n >= 1 && n <= 65535)) n = DEFAULT_PORT;
  remotePort.value = n;
  chrome.storage.local.set({ remotePort: n });
}
remotePort.addEventListener('change', savePort);

enabledToggle.addEventListener('change', () => {
  const enabled = enabledToggle.checked;
  chrome.storage.local.set({ feedEnabled: enabled });
  sendToFeeds({ type: 'feed-toggle', enabled });
});

// Custom config: on = load colors/size from config.json; off = built-in
// defaults. Toggling re-applies live and re-reads the file, so off/on picks up
// edits you've made to config.json.
customConfig.addEventListener('change', () => {
  const enabled = customConfig.checked;
  chrome.storage.local.set({ customConfig: enabled });
  sendToFeeds({ type: 'custom-config', enabled });
});

openFeedsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: SHOW_URL });
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  statusEl.textContent = tab && STREAM_MATCH.test(tab.url || '') ? 'Active on this camera page.' : 'Not on a live feed page.';
});

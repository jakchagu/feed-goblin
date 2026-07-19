// Isolated-world content script for the stream page. chrome.* APIs live
// here, not in page-inject.js (page context can't see them), so this file's
// job is bridging: inject the page-context script, and relay
// storage/messages across the postMessage boundary.
//
// This listener is registered synchronously before page-inject.js is
// injected, so page-inject can reliably *request* its startup state (enabled
// + cameras) and get an answer. Pushing state at page-inject would race its
// listener registration and could be dropped.
(function () {
  'use strict';

  // Fetch the user's config.json (a gitignored file they create by copying
  // config.example.json). Only the content script can read extension files, so
  // it fetches + parses and hands the config to the page context.
  async function loadConfig() {
    try {
      const res = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null; // missing or invalid config.json -> built-in defaults
    }
  }

  function respondState() {
    chrome.storage.local.get(['feedEnabled', 'feedCameras', 'customConfig'], async (res) => {
      const config = res.customConfig ? await loadConfig() : null;
      window.postMessage(
        {
          source: 'feedcompanion-content',
          type: 'state',
          enabled: res.feedEnabled !== false,
          cameras: res.feedCameras || [],
          config: config,
        },
        '*'
      );
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'feedcompanion-page') return;
    if (data.type === 'requestState') respondState();
  });

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/content/page-inject.js');
  script.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'feed-toggle') {
      window.postMessage({ source: 'feedcompanion-content', type: 'toggle', enabled: msg.enabled }, '*');
    }
    if (msg && msg.type === 'custom-config') {
      (async () => {
        const config = msg.enabled ? await loadConfig() : null;
        window.postMessage({ source: 'feedcompanion-content', type: 'config', config: config }, '*');
      })();
    }
    // Stream Deck / bridge command relayed by the service worker. Forward it
    // across the postMessage boundary to the page context, which runs it
    // through the same action functions the hotkeys use.
    if (msg && msg.type === 'remote-command') {
      window.postMessage(
        { source: 'feedcompanion-content', type: 'remote-command', action: msg.action, mode: msg.mode, on: msg.on },
        '*'
      );
    }
  });
})();

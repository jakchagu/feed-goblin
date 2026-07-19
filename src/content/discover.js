// Runs on the show's live-feed hub page. Scrapes the camera-switch links
// (Camera 1-4, Multi-View) and caches them so the stream-page hotkeys
// don't have to hardcode season-specific GUIDs.
(function () {
  'use strict';

  function scrapeCameras() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/live-tv/stream/big_brother/"]'));
    const byLabel = new Map();
    for (const a of anchors) {
      const img = a.querySelector('img');
      const label = img && img.alt ? img.alt.trim() : null;
      const match = a.href.match(/big_brother\/([a-f0-9-]{36})/i);
      if (!label || !match || byLabel.has(label)) continue;
      byLabel.set(label, { label, guid: match[1], href: a.href.split('?')[0] });
    }
    const order = ['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4', 'Multi-View'];
    return order.map((l) => byLabel.get(l)).filter(Boolean);
  }

  function attempt(retriesLeft) {
    const cameras = scrapeCameras();
    if (cameras.length >= 4) {
      chrome.storage.local.set(
        { feedCameras: cameras, feedCamerasUpdatedAt: Date.now() },
        () => console.log('[FeedGoblin] cached', cameras.length, 'camera links', cameras)
      );
      return;
    }
    if (retriesLeft > 0) setTimeout(() => attempt(retriesLeft - 1), 1000);
  }

  attempt(15);
})();

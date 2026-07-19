// Page-context script. Runs in the site's own JS environment (not the
// isolated content-script world) because it needs to reach the real player
// object hanging off the <video> element. Talks to content-script.js via
// window.postMessage for anything that needs chrome.* APIs.
(function () {
  'use strict';

  // ===== LOGGER, CONFIG, MODULE STATE =====
  const NS = '[FeedGoblin]';
  const log = (...args) => console.log(NS, ...args);

  // Reload backoff: a persistently broken stream must not turn into an
  // endless reload loop. State lives in localStorage so it survives the
  // reload it's throttling.
  const RELOAD_KEY = 'feedcompanion_reloads';
  const MAX_RELOADS = 5; // give up after this many within the window
  const RELOAD_WINDOW_MS = 2 * 60 * 1000; // errors older than this reset the count
  const RELOAD_COOLDOWN_MS = 8000; // minimum gap between reloads

  let enabled = false;
  let cameras = [];
  let qualityTimer = null;
  let watchTimer = null;
  let audioCtx = null;
  let splitter = null;
  let merger = null;
  let hookedVideo = null;
  let currentConfig = null; // last custom config applied (colors + size), or null for built-in defaults

  const AUDIO_MODE_KEY = 'feedcompanion_audiomode';
  function readAudioMode() {
    try {
      const m = localStorage.getItem(AUDIO_MODE_KEY);
      return m === 'left' || m === 'right' ? m : 'center';
    } catch (e) {
      return 'center';
    }
  }
  // restore the last L/C/R selection across reloads and camera switches
  let audioMode = readAudioMode();
  let playerReadyDone = false;
  let volumeWatchVideo = null;
  let errorTicks = 0;
  let lastProgressTime = -1;
  let stallTicks = 0;

  const STALL_TICKS = 3; // ~6s of frozen playback (checks run every 2s)

  const AUDIO_PREFS_KEY = 'feedcompanion_audio';

  // ===== VIDEO / PLAYER ACCESS =====
  // During load P+ briefly has two <video> elements, and the playing one
  // isn't always index 0. Prefer whichever has the player object attached;
  // fall back to the first element only before the player exists.
  function getVideo() {
    const vids = document.querySelectorAll('video');
    for (const v of vids) if (v.player) return v;
    return vids[0] || null;
  }

  function getPlayer() {
    const video = getVideo();
    return (video && video.player) || null;
  }

  // ===== QUALITY CAP =====
  // The site caps live-feed quality below what the stream actually offers.
  // Read the real ceiling off the manifest instead of hardcoding a target,
  // so this doesn't need updating if the encode ladder changes next season.
  function fixQuality() {
    const video = getVideo();
    const player = video && video.player;
    if (!player || typeof player.getAdapter !== 'function') return;
    const playback = player.getAdapter('playback');
    if (!playback || !playback.qualities || !playback.qualities.length) return;

    const bestHeight = Math.max(...playback.qualities.map((q) => q.height || 0));
    const bestBitrate = Math.max(...playback.qualities.map((q) => q.bitrate || 0));

    if (playback.maxHeight !== bestHeight || playback.maxBitrate !== bestBitrate) {
      playback.maxHeight = bestHeight;
      playback.maxBitrate = bestBitrate;
      if (typeof playback.refreshQualities === 'function') playback.refreshQualities();
      log('raised quality cap to', bestHeight + 'p', bestBitrate + 'bps');
    }

    if (!player.autoQualitySwitching) {
      player.autoQualitySwitching = true;
      if (typeof playback.refreshQualities === 'function') playback.refreshQualities();
    }
  }

  // ===== AUDIO: MUTE / VOLUME PERSISTENCE =====
  // P+ starts every feed muted (browser autoplay policy). Switching cameras
  // is a full navigation, so without this you're re-muted on every switch.
  // We remember the desired mute/volume and reassert it - once when the
  // player is ready, and again on each hotkey press (a user gesture, which
  // the autoplay policy will honor even when the programmatic set is ignored).
  function readAudioPrefs() {
    try {
      return JSON.parse(localStorage.getItem(AUDIO_PREFS_KEY)) || { muted: false };
    } catch (e) {
      return { muted: false };
    }
  }

  function saveAudioPrefs(prefs) {
    try {
      localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {
      /* ignore */
    }
  }

  function applyAudioPrefs(video) {
    if (!video) return;
    const prefs = readAudioPrefs();
    // Muting never needs a gesture, so it's always safe to reassert.
    if (prefs.muted === true) {
      video.muted = true;
      return;
    }
    // Unmuting an autoplaying video WITHOUT a user gesture makes Chrome pause
    // it ("the video just stops"). Only unmute when there's active user
    // activation - the gesture paths (first click/keypress, hotkeys) have it;
    // the player-ready timer call does not, so it safely skips.
    if (prefs.muted === false) {
      const activated = navigator.userActivation ? navigator.userActivation.isActive : false;
      if (activated) video.muted = false;
    }
  }

  function watchVolume(video) {
    if (!video || video === volumeWatchVideo) return;
    volumeWatchVideo = video;
    video.addEventListener('volumechange', () => {
      saveAudioPrefs({ muted: video.muted, volume: video.volume });
    });
  }

  // Restore desired audio on the first real user gesture, then detach. The
  // autoplay policy always honors a gesture-driven unmute even when the
  // programmatic one at player-ready gets ignored.
  function armFirstGestureAudio() {
    const handler = () => {
      applyAudioPrefs(getVideo());
      restoreAudioMode(); // gesture present -> context can run, so isolation sticks
      window.removeEventListener('pointerdown', handler, true);
      window.removeEventListener('keydown', handler, true);
    };
    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('keydown', handler, true);
  }

  // Runs once per page load, as soon as the player is available.
  function onPlayerReady() {
    const player = getPlayer();
    const video = getVideo();
    if (!player || playerReadyDone) return;
    playerReadyDone = true;
    applyAudioPrefs(video);
    watchVolume(video);
    armFirstGestureAudio();
    restoreAudioMode(); // auto-restore L/R now if the context can already run
    log('player ready: audio prefs applied');
  }

  // ===== PLAYER KEYS + PER-TICK MAINTAIN =====
  let keysDisabledLogged = false;

  // Turn off P+'s own keyboard shortcuts so our hotkeys don't also trigger
  // its guide/navigation overlay. This beats fighting event propagation:
  // P+ registers its key listener ahead of ours, so stopPropagation alone
  // loses the race. Called every tick since a context change may re-enable.
  function disablePlayerKeys() {
    const player = getPlayer();
    if (!player || typeof player.disableKeyCommands !== 'function') return;
    try {
      player.disableKeyCommands();
      if (!keysDisabledLogged) {
        log('disabled P+ key commands');
        keysDisabledLogged = true;
      }
    } catch (e) {
      /* ignore */
    }
  }

  function maintain() {
    onPlayerReady();
    disablePlayerKeys();
    fixQuality();
    moveAudioUIForFullscreen();
  }

  // ===== AUTO-RECOVERY (error / stall -> reload, with backoff) =====
  function readReloadState() {
    try {
      return JSON.parse(localStorage.getItem(RELOAD_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function writeReloadState(state) {
    try {
      localStorage.setItem(RELOAD_KEY, JSON.stringify(state));
    } catch (e) {
      /* storage may be unavailable; degrade to no-backoff rather than crash */
    }
  }

  function clearReloadState() {
    try {
      localStorage.removeItem(RELOAD_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function handlePlaybackError() {
    const now = Date.now();
    const state = readReloadState();

    // Reset the counter if the last error was long enough ago that this is
    // probably a fresh problem, not the same one looping.
    if (!state.firstAt || now - state.firstAt > RELOAD_WINDOW_MS) {
      state.firstAt = now;
      state.count = 0;
    }

    if (state.count >= MAX_RELOADS) {
      log('playback error persists after', MAX_RELOADS, 'reloads - giving up (reload the tab to retry)');
      return;
    }

    if (state.lastAt && now - state.lastAt < RELOAD_COOLDOWN_MS) {
      return; // still within cooldown; wait for the next tick
    }

    state.count += 1;
    state.lastAt = now;
    writeReloadState(state);
    log('playback error, reload attempt', state.count, 'of', MAX_RELOADS);
    location.reload();
  }

  // Every P+ playback-failure card shows an "error code: NNNN" line - that's
  // the reliable signal across variants (3304 "trouble playing this video",
  // 3005 "video is currently unavailable", etc). Matching visible text rather
  // than a CSS class keeps this working across markup/season changes. We
  // require the error to persist across two checks (~2s) so a momentary flash
  // that self-recovers doesn't trigger a needless reload.
  function isErrorShown(bodyText) {
    return (
      /error code:?\s*\d+/i.test(bodyText) ||
      /video is currently unavailable/i.test(bodyText) ||
      /trouble playing this video/i.test(bodyText)
    );
  }

  function watchForTrouble() {
    const bodyText = document.body.innerText || '';
    if (isErrorShown(bodyText)) {
      errorTicks += 1;
      if (errorTicks >= 2) {
        errorTicks = 0;
        handlePlaybackError();
      }
      return;
    }
    errorTicks = 0;

    // Stall detection: the stream can "just stop" - freeze with no error card,
    // so the text check above never fires. If the video should be playing
    // (not user-paused) but currentTime hasn't advanced for ~6s, treat it as a
    // break and reload. Only counts once playback has actually started, so a
    // slow initial load isn't mistaken for a stall.
    const video = getVideo();
    if (video && !video.paused && video.currentTime > 0) {
      if (video.currentTime === lastProgressTime) {
        stallTicks += 1;
        if (stallTicks >= STALL_TICKS) {
          stallTicks = 0;
          log('playback stalled (no progress ~' + STALL_TICKS * 2 + 's)');
          handlePlaybackError();
          return;
        }
      } else {
        // real progress: healthy, so reset stall + reload counters
        stallTicks = 0;
        lastProgressTime = video.currentTime;
        clearReloadState();
      }
    } else {
      // paused (by the user) or not started yet - not a stall; rebaseline so
      // resuming isn't misread as frozen.
      stallTicks = 0;
      if (video) lastProgressTime = video.currentTime;
    }

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const stillWatchingBtn = buttons.find((b) =>
      /still watching|continue watching|yes,?\s*i.?m still/i.test(b.textContent || '')
    );
    if (stillWatchingBtn) {
      log('auto-dismissing still-watching prompt');
      stillWatchingBtn.click();
    }
  }

  // ===== AUDIO CHANNEL ISOLATION (Web Audio graph) =====
  // The multiview is a single stereo track that carries different cameras on
  // the left vs right source channel. To "hear one camera" we isolate a
  // source channel and route it to BOTH output channels - which a
  // StereoPanner can't do (hard-panning outputs L+R summed). ChannelSplitter
  // -> ChannelMerger gives real isolation. Confirmed non-silent on the live
  // DRM stream via createMediaElementSource.
  async function ensureRunningContext() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
      } catch (e) {
        /* stays suspended until a gesture */
      }
    }
    return audioCtx.state === 'running';
  }

  // createMediaElementSource permanently reroutes the element's audio through
  // Web Audio - if the context is suspended, that reroute is SILENT and can't
  // be undone. So we only hook once the context is actually running; otherwise
  // we leave native audio playing and retry on the next user gesture.
  async function hookAudio() {
    const video = getVideo();
    if (!video || video === hookedVideo) return !!hookedVideo;
    const running = await ensureRunningContext();
    if (!running) return false;
    try {
      const source = audioCtx.createMediaElementSource(video);
      splitter = audioCtx.createChannelSplitter(2);
      merger = audioCtx.createChannelMerger(2);
      source.connect(splitter);
      // Split then merge so a single source channel can be routed to BOTH
      // outputs for L/R isolation (see applyAudioMode); merger -> destination.
      merger.connect(audioCtx.destination);
      hookedVideo = video;
      applyAudioMode(); // establish current splitter -> merger routing
      log('audio channel isolation hooked');
      return true;
    } catch (e) {
      log('audio hook failed:', e.message);
      return false;
    }
  }

  // Restore saved isolation if it needs the Web Audio graph. Safe to call
  // without a gesture: hookAudio no-ops (leaving native sound) until the
  // context can run.
  function restoreAudioMode() {
    if (audioMode === 'left' || audioMode === 'right') hookAudio();
  }

  function applyAudioMode() {
    if (!splitter || !merger) return;
    // Re-point splitter->merger for the current L/C/R selection. NOTE:
    // disconnect(node) THROWS if that edge doesn't exist yet — the case on the
    // very first call (before any splitter->merger connection). Guard it, or the
    // throw aborts this function before it wires audio to the output (that was
    // the "no sound after isolating" bug). KEEP this guard.
    try {
      splitter.disconnect(merger);
    } catch (e) {
      /* not connected to merger yet — nothing to drop */
    }
    if (audioMode === 'left') {
      // left source channel -> both outputs
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 0, 1);
    } else if (audioMode === 'right') {
      // right source channel -> both outputs
      splitter.connect(merger, 1, 0);
      splitter.connect(merger, 1, 1);
    } else {
      // center: normal stereo passthrough
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 1, 1);
    }
  }

  async function setAudioMode(mode) {
    audioMode = mode;
    try {
      localStorage.setItem(AUDIO_MODE_KEY, mode);
    } catch (e) {
      /* ignore */
    }
    updateAudioUI(); // reflect the selection immediately
    if (!splitter) {
      // 'center' is plain stereo — if we've never hooked the graph, leave native
      // audio untouched. Only hook when isolating. This is a gesture path, so
      // the context will run.
      if (mode === 'center') return;
      await hookAudio();
    } else {
      await ensureRunningContext();
      applyAudioMode();
    }
    log('audio mode:', mode);
  }

  // ===== ON-SCREEN CONTROL (the quad grid UI) =====
  // On-screen L / Center / R control for the multiview (the Feed Goblin quad
  // grid). Only the quad packs different cameras into the L/R channels, so we
  // show it there and nowhere else. Clicking a side drives the same setAudioMode()
  // as the Q/W/E hotkeys, and the lit cells track the current mode (hotkey or click).
  let audioUI = null;

  function isMultiView() {
    const mv = cameras.find((c) => /multi.?view/i.test(c.label || ''));
    if (!mv) return false;
    const norm = (u) => (u || '').split('?')[0].replace(/\/$/, '');
    return norm(location.href) === norm(mv.href);
  }

  function injectAudioUIStyle() {
    if (document.getElementById('feedcompanion-audio-style')) return;
    const style = document.createElement('style');
    style.id = 'feedcompanion-audio-style';
    style.textContent =
      // Compact by default: the Feed Goblin quad grid, sized in vmin so it scales
      // with the feed window (small window -> small control) and clamped so it
      // never dominates. Lit (green) cells show the live channel, so it doubles as
      // a passive indicator. Hover grows it and reveals the Left/Center/Right words.
      '#feedcompanion-audio-bar{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'z-index:2147483647;display:flex;flex-direction:column;align-items:center;' +
      '--fc-q:calc(max(11px,3.25vmin) * var(--fc-scale, 1));' +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      'user-select:none;-webkit-user-select:none;}' +
      // rollover: grow the grid and drop in the word labels
      '#feedcompanion-audio-bar.fc-open{--fc-q:calc(max(56px,11vmin) * var(--fc-scale, 1));}' +
      '#feedcompanion-audio-bar .fc-quad{width:var(--fc-q);height:var(--fc-q);display:block;' +
      'cursor:pointer;filter:drop-shadow(0 2px 7px rgba(0,0,0,0.5));' +
      'transition:width .18s ease,height .18s ease;}' +
      '#feedcompanion-audio-bar .fc-frame{fill:var(--fc-frame,#2d1b4e);}' +
      '#feedcompanion-audio-bar .fc-cell{fill:var(--fc-cell-off,#241640);stroke:var(--fc-cell-stroke,#cfc6e8);stroke-width:3;' +
      'transition:fill .14s ease,stroke .14s ease;}' +
      '#feedcompanion-audio-bar .fc-cell.on{fill:var(--fc-active,#41d914);stroke:var(--fc-active,#41d914);}' +
      '#feedcompanion-audio-bar .fc-zone{fill:transparent;cursor:pointer;}' +
      // labels sit ABSOLUTE below the grid (out of flow) so the collapsed state
      // adds no height — otherwise its margin makes the bar taller than the grid
      // and the grid rides ~3px high of true center (obvious now the grid is tiny)
      '#feedcompanion-audio-bar .fc-labels{position:absolute;top:100%;left:50%;' +
      // padding-top (not margin) bridges the grid->labels gap so the pointer never
      // crosses a non-hover zone on the way down (which would collapse the control)
      'transform:translateX(-50%);padding-top:6px;display:flex;gap:5px;opacity:0;' +
      'pointer-events:none;white-space:nowrap;transition:opacity .16s ease;}' +
      '#feedcompanion-audio-bar.fc-open .fc-labels{opacity:1;pointer-events:auto;}' +
      '#feedcompanion-audio-bar .fc-labels span{font-size:calc(14px * var(--fc-scale, 1));font-weight:600;color:var(--fc-label-text,#cfc6e8);' +
      'background:var(--fc-label-bg,rgba(45,27,78,0.82));padding:calc(7px * var(--fc-scale, 1)) calc(16px * var(--fc-scale, 1));border-radius:6px;cursor:pointer;' +
      'white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.6);}' +
      '#feedcompanion-audio-bar .fc-labels span:hover{background:rgba(255,255,255,0.12);}' +
      '#feedcompanion-audio-bar .fc-labels span.on{background:var(--fc-active,#41d914);color:var(--fc-active-text,#0c2a06);text-shadow:none;}';
    (document.head || document.documentElement).appendChild(style);
  }

  function buildAudioUI() {
    if (audioUI || !isMultiView() || !document.body) return;
    injectAudioUIStyle();
    const SVGNS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs) => {
      const el = document.createElementNS(SVGNS, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      return el;
    };
    const bar = document.createElement('div');
    bar.id = 'feedcompanion-audio-bar';

    // Hover-intent: open on enter, close on leave after a short delay, so moving
    // the pointer across the grid->labels gap (or diagonally to a side label)
    // never collapses it mid-travel. A click selects the mode and closes at once.
    let closeTimer;
    const openUI = () => { clearTimeout(closeTimer); bar.classList.add('fc-open'); };
    const closeUI = () => { clearTimeout(closeTimer); closeTimer = setTimeout(() => bar.classList.remove('fc-open'), 250); };
    bar.addEventListener('mouseenter', openUI);
    bar.addEventListener('mouseleave', closeUI);
    const pick = (mode) => { setAudioMode(mode); clearTimeout(closeTimer); bar.classList.remove('fc-open'); };

    // The quad logo IS the control: each rounded cell is a camera slot, and lit
    // (green) cells show the active channel — left column = left, right column =
    // right, all four = center/both. Three transparent zones (left col / center
    // seam / right col) and the word labels all drive the same setAudioMode().
    const svg = svgEl('svg', { viewBox: '0 0 120 120', class: 'fc-quad' });
    svg.appendChild(svgEl('rect', { x: 1, y: 1, width: 118, height: 118, rx: 16, class: 'fc-frame' }));
    // cells in document order = index 0..3: TL, TR, BL, BR (updateAudioUI lights by index).
    // Minimal padding/gap so the footprint is mostly cells — the purple frame is
    // just a thin border; the point is showing which side has sound, not the logo.
    [[8, 8], [64, 8], [8, 64], [64, 64]].forEach(([x, y]) =>
      svg.appendChild(svgEl('rect', { x, y, width: 48, height: 48, rx: 10, class: 'fc-cell' }))
    );
    [['left', 0, 52], ['center', 52, 16], ['right', 68, 52]].forEach(([mode, x, w]) => {
      const z = svgEl('rect', { x, y: 0, width: w, height: 120, class: 'fc-zone', 'data-mode': mode });
      z.addEventListener('click', () => pick(mode));
      svg.appendChild(z);
    });
    bar.appendChild(svg);

    // words, hidden until hover — self-labels the sides on expand
    const labels = document.createElement('div');
    labels.className = 'fc-labels';
    [['left', 'Left'], ['center', 'Center'], ['right', 'Right']].forEach(([mode, word]) => {
      const s = document.createElement('span');
      s.dataset.mode = mode;
      s.textContent = word;
      s.addEventListener('click', () => pick(mode));
      labels.appendChild(s);
    });
    bar.appendChild(labels);

    document.body.appendChild(bar);
    audioUI = bar;
    applyConfig(currentConfig);
    updateAudioUI();
    document.addEventListener('fullscreenchange', moveAudioUIForFullscreen, true);
    document.addEventListener('webkitfullscreenchange', moveAudioUIForFullscreen, true);
    moveAudioUIForFullscreen();
  }

  // A body-level overlay isn't rendered while another element is fullscreen -
  // only the fullscreen element and its descendants are. So when the player
  // goes fullscreen, move the bar inside the fullscreen element; move it back
  // to <body> on exit. position:fixed keeps it centered in both cases.
  function moveAudioUIForFullscreen() {
    if (!audioUI) return;
    let fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
    // Can't overlay HTML on a raw <video>; use its container instead.
    if (fsEl && fsEl.tagName === 'VIDEO' && fsEl.parentElement) fsEl = fsEl.parentElement;
    const target = fsEl || document.body;
    if (audioUI.parentElement !== target) target.appendChild(audioUI);
  }

  function updateAudioUI() {
    if (!audioUI) return;
    // light the cells for the active channel (index order TL,TR,BL,BR) and mark
    // the matching word label
    const lit = { left: [0, 2], center: [0, 1, 2, 3], right: [1, 3] }[audioMode] || [];
    audioUI.querySelectorAll('.fc-cell').forEach((cell, i) => {
      cell.classList.toggle('on', lit.indexOf(i) > -1);
    });
    audioUI.querySelectorAll('.fc-labels span').forEach((s) => {
      s.classList.toggle('on', s.dataset.mode === audioMode);
    });
  }

  function setAudioUIVisible(visible) {
    if (audioUI) audioUI.style.display = visible ? 'flex' : 'none';
  }

  // Apply (or clear) the custom config: colors + size become CSS vars on the
  // control, with the stylesheet's built-in values as the fallbacks. cfg = null
  // reverts to defaults ("Custom config" off). page-inject can't read the file
  // itself, so the content script fetches config.json and passes it here.
  function applyConfig(cfg) {
    currentConfig = cfg || null;
    if (!audioUI) return;
    const el = audioUI;
    const set = (name, val) => (val ? el.style.setProperty(name, val) : el.style.removeProperty(name));
    const c = (cfg && cfg.colors) || {};
    set('--fc-frame', c.frame);
    set('--fc-cell-off', c.cellOff);
    set('--fc-cell-stroke', c.cellStroke);
    set('--fc-active', c.active);
    set('--fc-active-text', c.activeText);
    set('--fc-label-text', c.labelText);
    set('--fc-label-bg', c.labelBg);
    set('--fc-scale', cfg && typeof cfg.scale === 'number' ? String(cfg.scale) : null);
  }

  // ===== KIOSK MODE (hide scrollbar in fullscreen) =====
  // Kiosk mode: hide the page scrollbar so the fullscreen watch view is clean.
  // Toggled by the /fullscreen remote command so normal browsing is untouched.
  const KIOSK_STYLE_ID = 'feedcompanion-kiosk-style';
  const KIOSK_KEY = 'feedcompanion_kiosk';

  // Just the visual — add/remove the scrollbar-hiding style.
  function applyKioskStyle(on) {
    let el = document.getElementById(KIOSK_STYLE_ID);
    if (on) {
      if (!el) {
        el = document.createElement('style');
        el.id = KIOSK_STYLE_ID;
        el.textContent = 'html,body{overflow:hidden !important;}';
        (document.head || document.documentElement).appendChild(el);
      }
    } else if (el) {
      el.remove();
    }
  }

  // Remote-command entry point: apply AND remember, so a page reload (including
  // the auto-recovery reload and camera-switch navigations) restores the same
  // kiosk state instead of dropping the scrollbar-hider while still fullscreen.
  function setKioskMode(on) {
    applyKioskStyle(on);
    try {
      if (on) localStorage.setItem(KIOSK_KEY, '1');
      else localStorage.removeItem(KIOSK_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  // Re-apply the remembered kiosk state on load, without touching the flag.
  function restoreKiosk() {
    let on = false;
    try {
      on = localStorage.getItem(KIOSK_KEY) === '1';
    } catch (e) {
      /* ignore */
    }
    applyKioskStyle(on);
  }

  // ===== INPUT: CAMERA NAV + HOTKEYS =====
  function goToCamera(index) {
    const cam = cameras[index];
    if (!cam) {
      log('no cached camera for slot', index + 1, '- open the show page once to (re)cache it');
      return;
    }
    const normalize = (u) => u.replace(/\/$/, '');
    if (normalize(location.href.split('?')[0]) === normalize(cam.href)) return;
    location.href = cam.href;
  }

  function onKeyDown(e) {
    if (!enabled) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // Don't hijack browser/OS chords (Ctrl+W close tab, Cmd+1 switch tab, etc).
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    let handled = true;
    switch (e.key) {
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
        goToCamera(Number(e.key) - 1);
        break;
      case 'q':
      case 'Q':
        setAudioMode('left');
        break;
      case 'w':
      case 'W':
        setAudioMode('center');
        break;
      case 'e':
      case 'E':
        setAudioMode('right');
        break;
      case 'f':
      case 'F': {
        const video = getVideo();
        const player = video && video.player;
        if (player && typeof player.toggleFullscreen === 'function') player.toggleFullscreen();
        break;
      }
      default:
        handled = false;
    }

    // Stop the site's own player shortcuts from also firing on our keys
    // (they pop the P+ navigation/guide overlay). We listen in the capture
    // phase, so halting here keeps the event from reaching those handlers.
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      // This keypress is a user gesture - a reliable moment to reassert the
      // desired unmute/volume that P+ resets on each load.
      applyAudioPrefs(getVideo());
    }
  }

  // ===== LIFECYCLE (enable / disable) =====
  function start() {
    if (qualityTimer) return;
    maintain(); // run immediately so key-commands/quality kick in fast
    qualityTimer = setInterval(maintain, 2000);
    watchTimer = setInterval(watchForTrouble, 2000);
    document.addEventListener('keydown', onKeyDown, true);
    restoreKiosk(); // survive reloads/navigations while fullscreen
    log('started');
  }

  function stop() {
    clearInterval(qualityTimer);
    qualityTimer = null;
    clearInterval(watchTimer);
    watchTimer = null;
    document.removeEventListener('keydown', onKeyDown, true);
    applyKioskStyle(false); // show the scrollbar again while disabled; keep the flag
    log('stopped');
  }

  function applyEnabled(next) {
    enabled = next !== false;
    if (enabled) start();
    else stop();
    setAudioUIVisible(enabled);
  }

  // ===== MESSAGE BRIDGE (content-script <-> page context) =====
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'feedcompanion-content') return;

    if (data.type === 'state') {
      cameras = data.cameras || [];
      currentConfig = data.config || null;
      log('received state: enabled=' + (data.enabled !== false), '|', cameras.length, 'camera link(s)');
      buildAudioUI(); // create the L/C/R control if this is the multiview
      applyEnabled(data.enabled);
    }
    if (data.type === 'toggle') {
      applyEnabled(data.enabled);
    }
    // Live custom-config toggle from the popup (colors + size, or revert).
    if (data.type === 'config') {
      applyConfig(data.config || null);
    }
    // Remote command from the Stream Deck bridge. Only audio L/C/R for now; it
    // drives the exact same setAudioMode() as the Q/W/E hotkeys and the on-page
    // control, so the grid UI updates to match.
    if (data.type === 'remote-command') {
      if (!enabled) return;
      if (data.action === 'audio' && (data.mode === 'left' || data.mode === 'center' || data.mode === 'right')) {
        setAudioMode(data.mode);
      }
      if (data.action === 'kiosk') {
        setKioskMode(!!data.on);
      }
    }
  });

  // Pull startup state (enabled + cameras). content-script.js has its listener
  // registered before this script runs, so this request/response is reliable.
  window.postMessage({ source: 'feedcompanion-page', type: 'requestState' }, '*');
})();

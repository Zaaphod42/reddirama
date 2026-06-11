// userscript/build.mjs
// Generates, from the SHARED code (src/media.js, src/order.js, src/slideshow-core.js,
// src/slideshow.css):
//   1) docs/index.html         — the "viewer" (static page hosted on GitHub Pages)
//   2) userscript/reddirama.user.js — the userscript (fetches the saved items + opens the viewer)
//
//   node userscript/build.mjs
//
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/^\s*import\s.*?;?\s*$/gm, '').replace(/^export\s+/gm, '');

// Public viewer URL (GitHub Pages). Repo: Zaaphod42/reddirama, Pages served from /docs.
const VIEWER_URL = 'https://zaaphod42.github.io/reddirama/';
const VIEWER_ORIGIN = 'https://zaaphod42.github.io';
// VIEWER build number, shown small and unobtrusive on the loading screen: lets Seb
// VERIFY that he is seeing the latest version (and not a cached one). Bump this on every viewer build.
const VIEWER_BUILD = '1.0.0';

const mediaSrc = strip(read('src/media.js'));            // normalizeSaved (userscript, reddit side)
const orderSrc = strip(read('src/order.js'));            // nextMode / orderItems (viewer)
const coreSrc = strip(read('src/slideshow-core.js'));    // startSlideshow (viewer)
const css = read('src/slideshow.css');

// ----------------------------------------------------------------------------
// 1) Viewer — docs/index.html (GitHub Pages origin: no Reddit CSP lock)
// Controls: wireframe Lucide icons (inline SVG, white via currentColor) for
// prev / next / play-pause / sound; #order and #speed stay as TEXT (variable
// values: Newest/Oldest/Shuffle, 3s..15s). slideshow-core toggles the 2-state
// icons (showIcon) and writes the textContent of #order / #speed.
// ----------------------------------------------------------------------------
const viewerBoot = `
// Initial screen + receiving items (postMessage from the Reddit userscript) + multi-sources.
// - Opened BY the userscript (window.opener exists) => we show "Loading…" then
//   start the slideshow as soon as the first batch of items arrives.
// - Direct visit of the URL (no opener) => we show the install tutorial.
//
// Protocol (bidirectional) with the userscript:
//   userscript -> viewer : {type:'rss-sources', sources:[{id,label,kind}], current}  (once)
//                          {type:'rss-items', sourceId, items}                        (per page)
//                          {type:'rss-done', sourceId}                                (after the last page)
//                          {type:'rss-error', reason}
//   viewer -> userscript : window.opener.postMessage({type:'rss-load', id, sort}, redditOrigin)
//      (sort is only read for feeds: 'hot'|'new'|'top')
// We capture redditOrigin from e.origin of the received messages (the opener may be
// www/old/sh.reddit.com) rather than hardcoding it.
(function () {
  var handle = null;
  var msg = document.getElementById('message');
  var loading = document.getElementById('msg-loading');
  var loadingText = document.getElementById('msg-loading-text');
  var install = document.getElementById('msg-install');
  var errorEl = document.getElementById('msg-error');
  var emptyMsg = document.getElementById('msg-empty');
  var select = document.getElementById('source-select');
  var openedByScript = !!window.opener;

  // Version badge. Normally shows a SINGLE version (viewer and userscript/extension match). If they
  // DIFFER (e.g. a stale cached viewer), it shows both ("<viewer> / us <script>") as a cache diagnostic.
  try {
    var _us = new URLSearchParams(location.search).get('us');
    var _vb = document.getElementById('ver-badge');
    var _v = '${VIEWER_BUILD}';
    if (_vb) _vb.textContent = (_us && _us !== _v) ? (_v + ' / us ' + _us) : _v;
  } catch (e) {}

  // Userscript origin, captured on the first received message (so we can reply with rss-load).
  var redditOrigin = null;
  // Source currently requested by the viewer + its kind ('saved'|'feed'). The
  // rss-items/rss-done batches of ANOTHER source (late replies) are ignored (anti-mixing).
  var currentSourceId = 'home';
  var currentKind = 'feed';
  // Map id -> kind, filled by rss-sources (to recover the kind when the source changes).
  var kindById = { home: 'feed' };

  // Gets a feed's default sort from localStorage (otherwise 'hot').
  // Sorts offered depending on the source: Home = best/hot/new/top (like Reddit); customs = hot/new/top.
  function feedSortsFor(id) { return id === 'home' ? ['hot', 'best', 'new', 'top'] : ['hot', 'new', 'top']; }
  function defaultFeedSort() {
    var valid = feedSortsFor(currentSourceId);
    try { var s = localStorage.getItem('rss_sort'); return valid.indexOf(s) !== -1 ? s : valid[0]; }
    catch (e) { return valid[0]; }
  }

  // Requests (or re-requests) the current source from the userscript. For a feed we include the sort.
  function requestLoad(sort) {
    if (window.opener && redditOrigin) {
      var payload = { type: 'rss-load', id: currentSourceId };
      if (currentKind === 'feed') payload.sort = sort || defaultFeedSort();
      try { window.opener.postMessage(payload, redditOrigin); } catch (e) {}
    }
  }

  // Shows the "Loading… [N]" screen (startup, source change, or waiting on saved
  // Oldest/Shuffle which requires the whole set). count optional => live counter.
  function showLoading(count) {
    if (!msg) return;
    msg.classList.remove('hidden');
    if (install) install.classList.add('hidden');
    if (errorEl) errorEl.classList.add('hidden');
    if (emptyMsg) emptyMsg.classList.add('hidden');
    if (loading) loading.classList.remove('hidden');
    if (loadingText) {
      loadingText.textContent = (typeof count === 'number' && count > 0)
        ? ('Loading\\u2026 ' + count + ' posts')
        : 'Loading your Reddit\\u2026';
    }
  }

  // onBusy(isBusy, count) — passed to slideshow-core. saved Oldest/Shuffle waits for the whole set:
  // while waiting we (re)show the loading screen with a live counter; otherwise we hide it.
  function onBusy(isBusy, count) {
    if (isBusy) { showLoading(count); }
    else if (msg) { msg.classList.add('hidden'); }
  }

  // onEmpty() — the current source is complete but contains NO media: we replace the
  // "Loading…" with a clear message. The dropdown menu (#topbar z-[60]) stays above the message,
  // so another source can be picked without reloading.
  function onEmpty() {
    if (!msg) return;
    msg.classList.remove('hidden');
    if (loading) loading.classList.add('hidden');
    if (install) install.classList.add('hidden');
    if (errorEl) errorEl.classList.add('hidden');
    if (emptyMsg) emptyMsg.classList.remove('hidden');
  }

  // onSort(sort) — a feed changed its sort (Hot/New/Top): we re-fetch the feed in that sort.
  // beginSource resets the buffer; rss-load{id,sort} restarts pagination on the userscript side.
  function onSort(sort) {
    if (!handle) return;
    // We do NOT show the loading screen here: we keep the controls (and the already-updated
    // sort label) visible during the feed re-fetch, so the choice is visible and can be
    // re-clicked. The current image stays displayed until the new items arrive.
    handle.beginSource({ kind: 'feed', feedSorts: feedSortsFor(currentSourceId) });
    requestLoad(sort);
  }

  // Creates the slideshow on first need (passes the busy/sort callbacks + the current kind).
  function ensureHandle() {
    if (!handle) handle = startSlideshow({ items: [], kind: currentKind, feedSorts: feedSortsFor(currentSourceId), slideSeconds: 5, onBusy: onBusy, onSort: onSort, onEmpty: onEmpty });
    return handle;
  }

  // SESSION cache (per tab): we remember the received items + the dropdown so we can
  // RESUME the slideshow if the tab is reloaded OR if we come back to it after opening a link
  // (the opener is then lost => without this we would fall back to the tutorial). sessionStorage
  // survives "back" and reload, and stays empty for a fresh tab (genuine first visit => tutorial).
  function saveCache() {
    try {
      if (!handle || !handle.state || !handle.state.raw.length) return;
      var sources = select ? Array.prototype.map.call(select.options, function (o) { return { id: o.value, label: o.textContent, kind: kindById[o.value] || 'saved' }; }) : [];
      sessionStorage.setItem('rss_cache', JSON.stringify({ sources: sources, currentSourceId: currentSourceId, currentKind: currentKind, items: handle.state.raw.slice(0, 400) }));
    } catch (e) { /* quota / unavailable: we ignore */ }
  }
  function restoreFromCache() {
    var cache;
    try { cache = JSON.parse(sessionStorage.getItem('rss_cache') || 'null'); } catch (e) { cache = null; }
    if (!cache || !Array.isArray(cache.items) || !cache.items.length) return false;
    kindById = {};
    if (select) select.innerHTML = '';
    (cache.sources || []).forEach(function (s) {
      if (!s || !s.id) return;
      kindById[s.id] = (s.kind === 'feed') ? 'feed' : 'saved';
      if (select) { var opt = document.createElement('option'); opt.value = s.id; opt.textContent = s.label || s.id; select.appendChild(opt); }
    });
    currentSourceId = cache.currentSourceId || 'home';
    currentKind = cache.currentKind || kindById[currentSourceId] || 'saved';
    if (select && (cache.sources || []).length) {
      select.value = currentSourceId; select.classList.remove('hidden');
      var chev = document.getElementById('source-chevron'); if (chev) chev.classList.remove('hidden');
    }
    var h = ensureHandle();
    h.beginSource({ kind: currentKind, feedSorts: feedSortsFor(currentSourceId) });
    h.addItems(cache.items);
    h.markComplete();
    if (msg) msg.classList.add('hidden');
    return true;
  }

  // Choosing the initial screen.
  if (msg) {
    if (openedByScript) {
      showLoading();
      // After ~20 s without a single item, we reassure the user (without breaking anything).
      setTimeout(function () {
        if (!handle) {
          var hint = document.getElementById('msg-loading-hint');
          if (hint) hint.classList.remove('hidden');
        }
      }, 20000);
    } else if (!restoreFromCache()) {
      if (install) install.classList.remove('hidden'); // no opener NOR cache => genuine direct visit
    }
  }

  // Source change via the dropdown: we read the kind, (re)initialize the slideshow for
  // that source, show the loading screen, and request the new source from the userscript (which
  // will increment its generation and stop sending the old one).
  if (select) {
    select.addEventListener('change', function () {
      currentSourceId = select.value;
      currentKind = kindById[currentSourceId] || 'saved';
      ensureHandle().beginSource({ kind: currentKind, feedSorts: feedSortsFor(currentSourceId) });
      showLoading();             // we wait while the new source arrives
      requestLoad();             // feed => default sort included
    });
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d) return;
    // Remember the userscript origin (so we can reply to it). We only keep the messages
    // from our protocol, and we prefer the opener (the expected source).
    if (d.type === 'rss-sources' || d.type === 'rss-items' || d.type === 'rss-done' || d.type === 'rss-error') {
      if (!window.opener || e.source === window.opener) redditOrigin = e.origin;
    }
    // Error reported by the userscript (edge case: not logged in). We hide the "Loading"
    // and show a clear message — that way the tab is never just black.
    if (d.type === 'rss-error') {
      if (loading) loading.classList.add('hidden');
      if (install) install.classList.add('hidden');
      if (errorEl) errorEl.classList.remove('hidden');
      return;
    }
    // Source list: we fill in + show the dropdown, remember the kinds, and
    // set the current source + its kind. NB: rss-sources may arrive AFTER the first batch of
    // 'saved' (both are fired from launch()) — so we only REINITIALIZE the slideshow if its
    // kind differs (otherwise we would wipe items already received). Since the default kind is 'saved'
    // (= that of the default source), no reset happens in the normal case.
    if (d.type === 'rss-sources' && Array.isArray(d.sources)) {
      kindById = {};
      if (select) select.innerHTML = '';
      d.sources.forEach(function (s) {
        if (!s || !s.id) return;
        kindById[s.id] = (s.kind === 'feed') ? 'feed' : 'saved';
        if (select) {
          var opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.label || s.id;
          select.appendChild(opt);
        }
      });
      currentSourceId = d.current || 'saved';
      currentKind = kindById[currentSourceId] || 'saved';
      if (select) { select.value = currentSourceId; select.classList.remove('hidden'); } // visible once populated
      var chevron = document.getElementById('source-chevron'); if (chevron) chevron.classList.remove('hidden'); // chevron revealed with the dropdown
      var h = ensureHandle();
      // beginSource ONLY if the effective kind changes (avoids wiping a batch in flight).
      if (h.state.kind !== currentKind) h.beginSource({ kind: currentKind, feedSorts: feedSortsFor(currentSourceId) });
      saveCache();
      return;
    }
    // End of pagination for a source: we unblock (saved Oldest/Shuffle can start).
    if (d.type === 'rss-done') {
      if (d.sourceId && d.sourceId !== currentSourceId) return; // stale source: we ignore
      if (handle) handle.markComplete();
      saveCache();
      return;
    }
    if (d.type !== 'rss-items' || !Array.isArray(d.items)) return;
    // Anti-mixing: we ignore batches from a source that is no longer the current source
    // (late replies arriving after a dropdown change).
    if (d.sourceId && d.sourceId !== currentSourceId) return;
    if (!d.items.length) return; // empty batch: we wait (next page)
    // It is the slideshow (slideshow-core) that decides WHEN to start (saved Newest/feed =
    // right away; saved Oldest/Shuffle = on completion) and that hides/shows the loading
    // screen via onBusy. We just hand it the items.
    ensureHandle().addItems(d.items);
    saveCache();
  });
})();`;

// --- Wireframe Lucide icons (inline SVG, white via currentColor) ---
// Common wrapper: viewBox 24, stroke 2, rounded caps. data-i is used by the 2-state buttons
// (slideshow-core.showIcon shows the matching svg and .hidden the other).
const svg = (paths, attr = '') =>
  `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${attr ? ' ' + attr : ''}>${paths}</svg>`;
const ICON = {
  prev: svg('<circle cx="12" cy="12" r="10"/><path d="m12 8-4 4 4 4"/><path d="M16 12H8"/>'),       // circle-arrow-left
  next: svg('<circle cx="12" cy="12" r="10"/><path d="m12 16 4-4-4-4"/><path d="M8 12h8"/>'),         // circle-arrow-right
  play: svg('<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>', 'data-i="play"'),                 // circle-play (shown when paused)
  pause: svg('<circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/>', 'data-i="pause"'), // circle-pause (shown when playing)
  soundOn: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>', 'data-i="on"'), // volume-2 (sound on)
  soundOff: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>', 'data-i="off"'), // volume-x (muted)
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 'class="w-5 h-5"'), // x (Lucide): closes the module, back to Reddit; w-5 h-5 forces 1:1 inside the square button
};

// ICON button: touch target >= 44px (h-11 w-11), no text, pointer cursor, gold accent on hover/press.
const ICON_BTN = 'flex items-center justify-center h-11 w-11 rounded-lg text-white/90 hover:text-white active:text-gold hover:bg-white/10 transition-colors cursor-pointer select-none';
// TEXT button (#order, #speed): FIXED width + centered text so a label change
// shifts nothing (Newest/Oldest/Shuffle, 3s..15s).
const TEXT_BTN = 'flex items-center justify-center h-11 px-[3px] rounded-lg text-sm text-white/90 hover:text-white active:text-gold hover:bg-white/10 transition-colors cursor-pointer select-none';
const W = {
  order: 'w-[60px] text-center',   // Newest / Oldest / Shuffle (tightest width)
  speed: 'w-[36px] text-center tabular-nums', // 3s..15s (tightest width)
};
// Layout in 3 equal-width zones (flex-1): the central trio (prev/play/next) stays
// CENTERED on screen regardless of the side widths.
//   left   (justify-start)  : #sound
//   center (justify-center) : #prev #playpause #next
//   right  (justify-end)    : #speed #order
const controlsHtml =
  '<div id="controls" class="fixed inset-x-0 bottom-0 z-30 flex items-center p-3 bg-gradient-to-t from-black/70 to-transparent transition-opacity duration-300">'
  + '<div class="flex-1 flex items-center justify-start">'
    + `<button id="sound" class="${ICON_BTN}" title="Sound (m)">${ICON.soundOn}${ICON.soundOff}</button>`
  + '</div>'
  + '<div class="flex-1 flex items-center justify-center">'
    + `<button id="prev" class="${ICON_BTN}" title="Previous">${ICON.prev}</button>`
    + `<button id="playpause" class="${ICON_BTN}" title="Play / Pause (a)">${ICON.play}${ICON.pause}</button>`
    + `<button id="next" class="${ICON_BTN}" title="Next">${ICON.next}</button>`
  + '</div>'
  + '<div class="flex-1 flex items-center justify-end">'
    + `<button id="speed" class="${TEXT_BTN} ${W.speed}" title="Speed (+/-)">5s</button>`
    + `<button id="order" class="${TEXT_BTN} ${W.order}" title="Order (o)">Newest</button>`
  + '</div>'
  + '</div>';

// TOP bar — same styling as #controls: hidden with body.idle (see slideshow.css),
// pointer-events:none once hidden. Two zones, ALIGNED (items-center) so nothing
// stretches vertically:
//   left  : #source-select (the source dropdown, hidden until rss-sources)
//   right : #close (x: closes the module and returns to the Reddit screen)
// The <select> is translucent WHITE (white text, NO border at rest = just the background; on focus,
// a 50%-opacity white outline + ring). `appearance-none`
// removes the native style. Height h-9, identical to the external button (square w-9 h-9) on the right.
const SELECT_CLASS = 'hidden appearance-none max-w-[45vw] h-9 pl-3 pr-8 rounded-lg bg-white/10 text-sm text-white border border-transparent hover:bg-white/20 focus:outline-none focus:border-white/50 focus:ring-1 focus:ring-white/50 cursor-pointer';
// External button: SQUARE (w-9 h-9 = same height as the select), centered icon, SVG at 1:1
// (viewBox 24, w-5 h-5) -> never stretched vertically.
const EXTERNAL_BTN = 'inline-flex items-center justify-center w-9 h-9 rounded-lg text-white/90 hover:text-white active:text-gold hover:bg-white/10 transition-colors cursor-pointer select-none';
// Lucide chevron (chevron-down) overlaid on the <select> (appearance-none removes the native arrow).
// Hidden while the dropdown is (revealed at the same time as it, see viewerBoot).
const chevronDown =
  '<svg id="source-chevron" class="hidden pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const topbarHtml =
  '<div id="topbar" class="fixed inset-x-0 top-0 z-[60] flex items-center justify-between p-3 pointer-events-none transition-opacity duration-300">'
  + '<div class="relative flex items-center pointer-events-auto">'
    + `<select id="source-select" class="${SELECT_CLASS}" title="Source"></select>`
    + chevronDown
  + '</div>'
  + '<div class="flex items-center pointer-events-auto">'
    + `<button id="close" class="${EXTERNAL_BTN}" title="Close (back to Reddit)">${ICON.close}</button>`
  + '</div>'
  + '</div>';

const viewerHtml =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  // Send no Referer for the media we load: a privacy-friendly default that also lets hotlink-protected
  // hosts serve their media to this hosted viewer (signed Reddit URLs work either way).
  + '<meta name="referrer" content="no-referrer">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
  + '<title>Reddirama</title>'
  + '<script src="https://cdn.tailwindcss.com"></script>'
  + '<script>tailwind.config={theme:{extend:{colors:{gold:{DEFAULT:\'#FF4500\',dark:\'#CC3700\'}}}}}</script>'
  // hls.js: reads the Reddit/redgifs HLS stream (which carries the SOUND) on browsers without native HLS
  // (Chrome/Firefox) => video sound everywhere, not just on Safari. Safari uses its native HLS.
  + '<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>'
  + '<style>' + css + '</style></head>'
  + '<body class="h-full bg-black text-white overflow-hidden">'
  // Fullscreen stage: the image/video (created by slideshow-core) fill it (object-contain).
  + '<div id="stage" class="fixed inset-0 flex items-center justify-center bg-black"></div>'
  // Centered icon flash (play/pause feedback on tap): a large play OR pause icon, animated by .flash
  // (see slideshow.css). showIcon (core) picks which one to show. pointer-events:none => intercepts nothing.
  + '<div id="tapflash">' + ICON.play + ICON.pause + '</div>'
  // Progress bar (top, gold). #progressTrack = touch zone (12px, pointer-events
  // enabled only on a video, see render); on touch, #progressTrackInner thickens to
  // 44px (see slideshow.css) and we seek within the video. The width of #progressBar is animated.
  + '<div id="progressTrack" class="fixed inset-x-0 top-0 z-40 h-11" style="touch-action:none;pointer-events:none">'
    + '<div id="progressTrackInner" class="relative h-[3px] bg-white/15">'
      + '<div id="progressBar" class="progress-bar absolute inset-y-0 left-0 w-0 bg-gold"></div>'
    + '</div>'
  + '</div>'
  // Title / subreddit overlay (subtle white, gold link).
  + '<div id="overlay" class="fixed inset-x-0 bottom-16 z-20 px-4 text-center pointer-events-none transition-opacity duration-300" style="text-shadow:0 1px 4px #000">'
    + '<a id="title" class="text-base font-medium text-white hover:text-gold no-underline pointer-events-auto" href="#" target="_self"></a>'
    + '<span id="sub" class="block mt-1 text-xs text-white/60"></span></div>'
  + topbarHtml
  + controlsHtml
  // Initial screen. Two mutually exclusive contents, hidden at first: viewerBoot
  // reveals "Loading" (opened by the userscript) OR the tutorial (direct visit).
  + '<div id="message" class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 px-6 text-center bg-black">'
    // (a) Loading (opened from Reddit by the userscript). #msg-loading-text receives the
    //     live counter ("Loading… N saved") while waiting on saved Oldest/Shuffle.
    + '<div id="msg-loading" class="hidden flex flex-col items-center gap-3">'
      + '<p id="msg-loading-text" class="text-base text-white/80 tabular-nums">Loading your Reddit&hellip;</p>'
      + '<p id="msg-loading-hint" class="hidden max-w-md text-sm text-white/50">Still loading. Make sure you clicked <span class="text-gold">Reddirama</span> on Reddit.</p>'
      + `<p id="ver-badge" class="text-[11px] text-white/25 tabular-nums">${VIEWER_BUILD}</p>`
    + '</div>'
    // (b) Install tutorial (URL opened directly, without the userscript).
    + '<div id="msg-install" class="hidden flex flex-col items-center gap-4 max-w-md">'
      + '<h1 class="text-2xl font-semibold tracking-tight">Reddirama</h1>'
      + '<p class="text-sm text-white/60">A fullscreen, hands-free slideshow for Reddit: play any subreddit or profile, your Home feed, or (logged in) your saved, upvoted and custom feeds. To use it, install the userscript, then launch it from Reddit:</p>'
      + '<ol class="text-left text-sm text-white/70 list-decimal list-inside space-y-2">'
        + '<li>Install the <a class="underline" href="https://apps.apple.com/app/userscripts/id1463298887" target="_blank" rel="noopener">Userscripts</a> app (iOS/Safari) or <a class="underline" href="https://www.tampermonkey.net/" target="_blank" rel="noopener">Tampermonkey</a> (Chrome).</li>'
        + '<li>Add the script from the repo: <a class="text-gold hover:underline" href="https://github.com/Zaaphod42/reddirama" target="_blank" rel="noopener">github.com/Zaaphod42/reddirama</a></li>'
        + '<li>Open <span class="text-white">reddit.com</span> and click <span class="text-gold">Reddirama</span>.</li>'
      + '</ol>'
    + '</div>'
    // (c) "Not logged in" error (postMessage rss-error from the userscript): never a black tab.
    + '<div id="msg-error" class="hidden flex flex-col items-center gap-3 max-w-md">'
      + '<p class="text-base text-white/80">Couldn&rsquo;t load from Reddit.</p>'
      + '<p class="text-sm text-white/50">Check your connection and click <span class="text-gold">Reddirama</span> again.</p>'
    + '</div>'
    // (d) Empty source: fully received but no media (text-only sub/profile) => clear message.
    + '<div id="msg-empty" class="hidden flex flex-col items-center gap-3 max-w-md">'
      + '<p class="text-base text-white/80">No media found in this source.</p>'
      + '<p class="text-sm text-white/50">Pick another source from the menu, top left.</p>'
    + '</div>'
  + '</div>'
  + '<script>\n' + orderSrc + '\n' + coreSrc + '\n' + viewerBoot + '\n</script>'
  + '</body></html>';

mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(join(ROOT, 'docs/index.html'), viewerHtml);

// ----------------------------------------------------------------------------
// 2) Userscript — fetches the saved items via the Reddit session, opens the viewer, sends the data
// ----------------------------------------------------------------------------
const header = `// ==UserScript==
// @name         Reddirama
// @namespace    https://github.com/Zaaphod42/reddirama
// @version      1.0.0
// @description  Fullscreen, hands-free slideshow for Reddit: any subreddit or profile, your Home feed, and (logged in) your saved, upvoted and custom feeds. Pick the source in the viewer; adjustable speed, sound, video scrubbing.
// @author       Zaaphod42
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @match        https://sh.reddit.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// !! File GENERATED by userscript/build.mjs — do not edit by hand.`;

const launcher = `  function fetchJson(url) {
    return fetch(url, { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function getUsername() {
    return fetchJson('https://www.reddit.com/api/me.json').then(function (me) {
      var name = (me && me.data && me.data.name) || me.name;
      if (!name) throw new Error('not_logged_in');
      return name;
    });
  }
  // Login check IN THE BACKGROUND, run once when the script loads. Lets us decide
  // SYNCHRONOUSLY (on click) whether to open the viewer: if we know the user is
  // logged out, we open no window (otherwise a stuck black tab). cachedName = name or null.
  var cachedName = null;
  var meChecked = false;
  var meCheck = fetch('https://www.reddit.com/api/me.json', { credentials: 'include', headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { return (d && d.data && d.data.name) || null; })
    .catch(function () { return null; });
  meCheck.then(function (name) { cachedName = name; meChecked = true; });
  // --- multi-source state ---
  // viewerWin  : reference to the opened viewer tab (target of the postMessages).
  // resolvedName : resolved username (reused by source reloads).
  // currentGen : generation counter. Every source load (default OR rss-load
  //   from the viewer) increments it; postItems and the pagination loop check
  //   "gen === currentGen" before sending => we stop emitting the pages of a stale
  //   source as soon as another is requested (anti-mixing when switching quickly).
  var viewerWin = null;
  var resolvedName = null;
  var currentGen = 0;
  // Small dark toast near the button (white text, ~5 s then auto-removed). Used for the
  // "not logged in" case: we warn ON the Reddit page instead of opening an empty tab.
  function showToast(text) {
    var t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;bottom:64px;right:16px;z-index:2147483647;max-width:280px;background:rgba(0,0,0,.85);color:#fff;border-radius:10px;padding:10px 14px;font:600 13px -apple-system,system-ui,sans-serif;line-height:1.35;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 5000);
  }
  // Adds limit/raw_json + (optional) the after cursor to a base URL.
  function withParams(base, after) {
    var u = base + (base.indexOf('?') === -1 ? '?' : '&') + 'limit=100&raw_json=1';
    if (after) u += '&after=' + encodeURIComponent(after);
    return u;
  }
  // Normalizes a feed sort received from the viewer into a valid API key (default 'hot').
  function normSort(sort) { return (sort === 'new' || sort === 'top' || sort === 'best') ? sort : 'hot'; }
  // Default sort on a source's first load: Home -> best; other feeds (Popular, subreddit,
  // custom feeds) -> hot; saved/upvoted/u:<name> -> null (ordered client-side, no server sort).
  function defaultSort(src) {
    if (!src) return null;
    return src.kind === 'feed' ? 'hot' : null; // feeds (Home, Popular, subreddit) -> Hot; saved/upvoted/u: -> null
  }
  // Maps a source id (+ sort for feeds) -> { url(base without params), cap(max number of pages) }.
  // Ids: 'saved' (default) & 'upvoted' (kind saved), 'home' (kind feed), 'feed:<path>' (multireddit; path
  // starts with /, kind feed). The sort only makes sense for feeds:
  //   • home       -> /<sort>.json            (hot/new/top)
  //   • feed:<path> -> <path><sort>.json
  //   • 'top' adds &t=all (all-time top).
  // (The sort/&t parameter is carried here via the base URL; withParams then adds
  //  limit/raw_json/after — without overwriting any &t=all already present.)
  function sourceSpec(id, name, sort) {
    var s = normSort(sort);
    var tAll = (s === 'top') ? '?t=all' : '';
    if (id === 'home') {
      return { url: 'https://www.reddit.com/' + s + '.json' + tAll, cap: 5 };
    }
    if (id && id.indexOf('feed:') === 0) {
      var path = id.slice(5); // e.g. /user/<name>/m/<feed>/
      return { url: 'https://www.reddit.com' + path + s + '.json' + tAll, cap: 5 };
    }
    if (id === 'upvoted') {
      // upvoted: a "your account" listing like saved (finite, ordered client-side, kind saved).
      return { url: 'https://www.reddit.com/user/' + encodeURIComponent(name) + '/upvoted.json', cap: 50 };
    }
    if (id && id.indexOf('user:') === 0) {
      // u/<name> (contextual button): posts SUBMITTED by this profile, ordered client-side like
      // saved (kind saved: newest/oldest/shuffle, no server sort). name is not used.
      return { url: 'https://www.reddit.com/user/' + encodeURIComponent(id.slice(5)) + '/submitted.json', cap: 50 };
    }
    // default: saved (finite, ordered client-side: no server sort)
    return { url: 'https://www.reddit.com/user/' + encodeURIComponent(name) + '/saved.json', cap: 50 };
  }
  // Sends a batch of items to the viewer (postMessage), TAGGED by sourceId. Retries a few
  // times (the page takes a moment to register its listener) — without breaking anything if it is
  // already ready. Generation guard: if a more recent load has started (stale gen),
  // we do not send the batch (avoids mixing two sources when switching quickly).
  function postItems(win, sourceId, items, gen) {
    if (!items.length || gen !== currentGen) return;
    var payload = { type: 'rss-items', sourceId: sourceId, items: items };
    [0, 300, 800, 1600].forEach(function (t) {
      setTimeout(function () { if (gen === currentGen) { try { win.postMessage(payload, VIEWER_ORIGIN); } catch (e) {} } }, t);
    });
  }
  // Tells the viewer that ALL pages of a source have been received (end of pagination).
  // Essential for saved Oldest/Shuffle: the viewer waits for this 'rss-done' before ordering
  // the whole set. Same retries/generation guard as postItems.
  function postDone(win, sourceId, gen) {
    if (gen !== currentGen) return;
    var payload = { type: 'rss-done', sourceId: sourceId };
    [0, 300, 800, 1600].forEach(function (t) {
      setTimeout(function () { if (gen === currentGen) { try { win.postMessage(payload, VIEWER_ORIGIN); } catch (e) {} } }, t);
    });
  }
  // Loads a source (saved/home/feed:<path>): maps id(+sort)->URL+cap, paginates by 'after',
  // normalizes (same normalizeSaved: these are all t3 children), and streams one batch
  // per page, tagged by sourceId, then 'rss-done' at the end. 'sort' is only used for
  // feeds (hot/new/top). The 'gen' guard stops sending as soon as a more recent load has started
  // (source change on the viewer side).
  async function loadSource(id, sort, gen) {
    var spec = sourceSpec(id, resolvedName, sort);
    var after = null, pages = 0;
    do {
      if (gen !== currentGen) return; // another source was requested: we give up
      var data = await fetchJson(withParams(spec.url, after));
      if (gen !== currentGen) return;
      var items = normalizeSaved((data && data.data && data.data.children) || []);
      postItems(viewerWin, id, items, gen); // first batch => start; following ones => addItems
      after = (data && data.data && data.data.after) || null;
      pages++;
    } while (after && pages < spec.cap);
    postDone(viewerWin, id, gen); // all pages sent: the viewer can order the complete set
  }
  // Gets the list of the logged-in user's custom feeds (multireddits).
  // Returns an array of {id:'feed:<path>', label:<display_name>} objects. Tolerant: on
  // failure (or no feed), returns [] (we keep at least Saved + Home).
  async function fetchFeeds() {
    try {
      var arr = await fetchJson('https://www.reddit.com/api/multi/mine.json?raw_json=1');
      if (!Array.isArray(arr)) return [];
      return arr.map(function (m) {
        var d = m && m.data;
        if (!d || !d.path) return null;
        return { id: 'feed:' + d.path, label: d.display_name || d.name || d.path };
      }).filter(Boolean);
    } catch (e) {
      return [];
    }
  }
  // Listens for the viewer's requests (different origin). On each {type:'rss-load', id, sort?}, we
  // bump the generation and (re)load the requested source (sort read for feeds: hot/new/top).
  // e.source === viewerWin guarantees the message really comes from OUR viewer tab.
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'rss-load' || !d.id) return;
    if (viewerWin && e.source !== viewerWin) return; // ignore other windows
    currentGen++;
    loadSource(d.id, d.sort, currentGen);
  });
  // primary (optional): source placed AT THE TOP of the dropdown and opened immediately (r/ and u/ buttons).
  //   {id,label,kind}; without it, we open Home by default (the Reddirama button's behavior).
  async function launch(btn, primary) {
    // OPTIONAL LOGIN: we no longer require being logged in. We always open the viewer (within the tap gesture);
    // logged out => public sources (Popular + the page's subreddit/profile), logged in => additionally
    // the personal sources (saved/upvoted/home/feeds).
    var orig = btn.textContent;
    // 1) Open the viewer SYNCHRONOUSLY, within the tap gesture. We keep the reference
    //    (viewerWin): it is the target of all the postMessages and the expected sender of the
    //    rss-load requests.
    // Cache-bust (?v=timestamp): forces the browser to load the LATEST viewer version on every
    // launch. Without it, the cached HTML (GitHub Pages ~10 min, aggressive Safari) hides viewer
    // updates (e.g. a sound fix). The origin stays the same => the postMessages still work.
    var US_BUILD = '1.0.0'; // userscript version, passed to the viewer (?us=) for the version badge (cache diag)
    var win = window.open(VIEWER_URL + '?v=' + Date.now() + '&us=' + US_BUILD, '_blank');
    if (!win) {
      if (btn && btn.id === 'rss-launch') { btn.textContent = '\\u2192 Allow pop-ups, then retry'; setTimeout(function () { btn.textContent = orig; }, 3000); }
      else { showToast('Allow pop-ups, then retry.'); }
      return;
    }
    viewerWin = win;
    // No "busy" state (… + disabled) on the button: the viewer already shows "Loading…", and
    // above all the Reddit tab goes to the background when the viewer opens in the foreground => iOS
    // suspends this script, so the restore (finally) did not run and left a frozen "…" + a stuck
    // button. We leave r/ /u/ /Reddirama intact and clickable (fixes the "…" stuck on return).
    try {
      // 2) Resolve the name WITHOUT blocking: logged in => name, logged out => null. (cachedName comes from
      //    the background check; if not done yet, we try now and tolerate failure.)
      var name = cachedName;
      if (name === null && !meChecked) { try { name = await getUsername(); } catch (e) { name = null; } }
      resolvedName = name;
      // 3) Sources depending on the login state. LOGGED IN: Home + Upvoted + Saved + personal feeds (kind
      //    drives the viewer's order/sort button). LOGGED OUT: PUBLIC only (Popular).
      var POPULAR = { id: 'feed:/r/popular/', label: 'Popular', kind: 'feed' };
      var sources, current;
      if (name) {
        var feeds = await fetchFeeds();
        sources = [{ id: 'home', label: 'Home', kind: 'feed' }, { id: 'upvoted', label: 'Upvoted', kind: 'saved' }, { id: 'saved', label: 'Saved', kind: 'saved' }].concat(feeds);
        current = 'home';
      } else {
        sources = [POPULAR];
        current = POPULAR.id;
      }
      // Contextual source (page's r/ or u/): AT THE TOP + current. Public => works logged in OR NOT.
      if (primary && primary.id) {
        current = primary.id;
        if (!sources.some(function (s) { return s.id === primary.id; })) sources = [primary].concat(sources);
      }
      [0, 300, 800, 1600].forEach(function (t) {
        setTimeout(function () { try { win.postMessage({ type: 'rss-sources', sources: sources, current: current }, VIEWER_ORIGIN); } catch (e) {} }, t);
      });
      // 4) Load the current source via the generalized loader (gen guard), with its default sort.
      currentGen++;
      var cur = null;
      for (var i = 0; i < sources.length; i++) { if (sources[i].id === current) { cur = sources[i]; break; } }
      await loadSource(current, defaultSort(cur), currentGen);
    } catch (e) {
      // Real NETWORK error (the "logged out" case is now handled, it is no longer an error).
      try { win.postMessage({ type: 'rss-error', reason: String(e.message) }, VIEWER_ORIGIN); } catch (_) {}
    }
  }
  // Detects the current Reddit page (read ON the button CLICK, because Reddit is a SPA): /r/<sub> =>
  // source of THIS subreddit (feed, sort hot/new/top); /user|u/<name> outside a multireddit (/m/) => posts
  // submitted by THIS profile (ordered client-side). Returned as 'primary' to launch (placed at the top of
  // the dropdown + played). Returns null elsewhere (=> Home by default). (The 'tag' field is unused.)
  function detectContext() {
    var p = location.pathname || '';
    var m = p.match(/^\\/r\\/([A-Za-z0-9_]+)(?:\\/|$)/);
    if (m) return { tag: 'r/', id: 'feed:/r/' + m[1] + '/', label: 'r/' + m[1], kind: 'feed' };
    m = p.match(/^\\/(?:user|u)\\/([A-Za-z0-9_-]+)(?:\\/|$)/);
    if (m && p.indexOf('/m/') === -1) return { tag: 'u/', id: 'user:' + m[1], label: 'u/' + m[1], kind: 'saved' };
    return null;
  }
  // A SINGLE "Reddirama" button (bottom-right). detectContext() is read ON CLICK: on a
  // subreddit/profile page, that subreddit/profile is placed AT THE TOP of the dropdown and played immediately;
  // elsewhere => Home by default. (Reddit is a SPA: we re-read the context on every click.)
  function addButton() {
    if (document.getElementById('rss-launch') || !document.body) return;
    var b = document.createElement('button');
    b.id = 'rss-launch';
    b.title = 'Play a fullscreen slideshow of your Reddit (saved, upvoted, home, this subreddit or profile, and feeds)';
    b.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;display:inline-flex;align-items:center;justify-content:center;gap:7px;background:#FF4500;color:#fff;border:0;border-radius:999px;padding:10px 16px 10px 13px;font:600 14px -apple-system,system-ui,sans-serif;cursor:pointer';
    // Reddirama logo (white) TO THE LEFT of the text. Built via DOM (createElementNS) rather than
    // innerHTML: robust if Reddit enforces Trusted Types (innerHTML='...' would throw there).
    var SVGNS = 'http://www.w3.org/2000/svg';
    var logo = document.createElementNS(SVGNS, 'svg');
    logo.setAttribute('viewBox', '0 0 1451.3 1451.3');
    logo.setAttribute('width', '11'); logo.setAttribute('height', '11');
    logo.setAttribute('fill', '#fff'); logo.setAttribute('aria-hidden', 'true');
    logo.style.flex = 'none';
    var lp = document.createElementNS(SVGNS, 'path');
    lp.setAttribute('d', 'M966.7,0v.2c-213.6,3.4-378.1,96.5-486.5,221.7h-9.2V21.2H0v1430.1h484.7v-.2c213.6-3.4,378.1-96.5,486.5-221.7h9.2v200.7h470.9V0h-484.7ZM782.6,1008.8c-53.7,22.6-109,34.6-164.1,34.6s-107.4-10.7-133.9-21v-306.1c0-134.2,78.2-227.3,184-273.8,53.7-22.6,109-34.6,164.1-34.6s107.4,10.7,133.9,21v306.1c0,134.2-78.2,227.3-184,273.8Z');
    logo.appendChild(lp);
    var label = document.createElement('span'); label.textContent = 'Reddirama';
    b.appendChild(logo); b.appendChild(label);
    b.addEventListener('click', function () { launch(b, detectContext()); });
    document.body.appendChild(b);
  }
  addButton();
  if (document.body) new MutationObserver(addButton).observe(document.body, { childList: true });`;

// SHARED script body (IIFE): identical for the userscript AND the extension's content script.
// (media.js for normalization + viewer URL + launcher: Reddit session fetch, button, postMessage.)
const scriptBody = '(function () {\n  \'use strict\';\n\n'
  + '  // ---- media normalization (generated from src/media.js) ----\n'
  + mediaSrc + '\n'
  + '  var VIEWER_URL = ' + JSON.stringify(VIEWER_URL) + ';\n'
  + '  var VIEWER_ORIGIN = ' + JSON.stringify(VIEWER_ORIGIN) + ';\n\n'
  + '  // ---- fetching the saved items (Reddit session) + opening the viewer ----\n'
  + launcher + '\n'
  + '})();\n';

// 2) Userscript (Tampermonkey / Userscripts app) = ==UserScript== header + shared body.
const userscript = header + '\n' + scriptBody;
writeFileSync(join(ROOT, 'userscript/reddirama.user.js'), userscript);

// 3) Chrome/Firefox extension (MV3) = the SAME shared body as a content script + manifest.
//    Injected into the MAIN world (like @grant none): Reddit session fetch + window.open + postMessage
//    identical to the userscript. Content scripts are exempt from Reddit's CSP. The viewer stays
//    hosted (GitHub Pages): the extension just opens it, exactly like the userscript.
const VERSION = (header.match(/@version\s+([\d.]+)/) || [])[1] || '0.0.0';
const extContent = '// Reddirama - content script. GENERATED from src/ by userscript/build.mjs: DO NOT edit by hand.\n'
  + '// Same code as the userscript; injected into the MAIN world of reddit.com (see manifest.json).\n\n'
  + scriptBody;
const manifest = {
  manifest_version: 3,
  name: 'Reddirama',
  version: VERSION,
  description: 'Fullscreen, hands-free slideshow for Reddit: any subreddit or profile, your Home, saved, upvoted and custom feeds.',
  homepage_url: 'https://github.com/Zaaphod42/reddirama',
  icons: { '16': 'icons/icon-16.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png', '512': 'icons/icon-512.png' },
  content_scripts: [{
    matches: ['https://www.reddit.com/*', 'https://old.reddit.com/*', 'https://sh.reddit.com/*'],
    js: ['content.js'],
    run_at: 'document_idle',
    world: 'MAIN',
  }],
  // data_collection_permissions: required by AMO for new submissions (since Nov 2025). Reddirama
  // collects no user data, so we declare the special value "none". strict_min_version is 142 because
  // data_collection_permissions is only recognized from Firefox 140 (desktop) / 142 (Android); 142
  // keeps AMO validation warning-free. (world:MAIN itself only needs 128, but 142 is ubiquitous now.)
  browser_specific_settings: { gecko: { id: 'reddirama-app@zaaphod42.github.io', strict_min_version: '142.0', data_collection_permissions: { required: ['none'] } } },
};
const extDir = 'extensions/chrome-firefox';
mkdirSync(join(ROOT, extDir, 'icons'), { recursive: true });
writeFileSync(join(ROOT, extDir, 'content.js'), extContent);
writeFileSync(join(ROOT, extDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Keep the Safari Xcode project's bundled copy of the extension in sync (if it exists), so the
// Safari build always uses the latest generated content.js / manifest.json / icons.
const safariRes = join(ROOT, 'extensions/safari/Reddirama/Shared (Extension)/Resources');
const safariSynced = existsSync(safariRes);
if (safariSynced) {
  copyFileSync(join(ROOT, extDir, 'content.js'), join(safariRes, 'content.js'));
  copyFileSync(join(ROOT, extDir, 'manifest.json'), join(safariRes, 'manifest.json'));
  // Safari uses the manifest `icons` for the toolbar too, and tints a grayscale icon grey (adapting it
  // to light/dark). So we sync a MONOCHROME icon set here -> grey toolbar. (Chrome/Firefox keep colour.)
  const grey = join(ROOT, 'extensions/safari-icons');
  for (const s of ['16', '48', '128', '512']) {
    const src = existsSync(join(grey, `icon-${s}.png`)) ? join(grey, `icon-${s}.png`) : join(ROOT, extDir, 'icons', `icon-${s}.png`);
    copyFileSync(src, join(safariRes, 'icons', `icon-${s}.png`));
  }
}

console.log('OK - generated:');
console.log('  • docs/index.html  (viewer, GitHub Pages)');
console.log('  • userscript/reddirama.user.js');
console.log('  • extensions/chrome-firefox/  (Chrome/Firefox MV3)' + (safariSynced ? '  -> also synced into extensions/safari/' : ''));

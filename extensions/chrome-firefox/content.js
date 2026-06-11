// Reddirama - content script. GENERATED from src/ by userscript/build.mjs: DO NOT edit by hand.
// Same code as the userscript; injected into the MAIN world of reddit.com (see manifest.json).

(function () {
  'use strict';

  // ---- media normalization (generated from src/media.js) ----
// lib/media.js
function decode(s) {
  return typeof s === 'string' ? s.replace(/&amp;/g, '&') : s;
}

function pickPreview(p) {
  const u = p?.preview?.images?.[0]?.source?.url;
  return u ? decode(u) : null;
}

function base(p) {
  return {
    id: p.name,
    title: p.title ?? '',
    permalink: `https://www.reddit.com${p.permalink ?? ''}`,
    subreddit: p.subreddit_name_prefixed ?? (p.subreddit ? `r/${p.subreddit}` : ''),
    author: p.author ?? '',
    nsfw: !!p.over_18,
  };
}

// Extracts the "strong" media from a post (gallery / video / image / gif). NOT the link-preview
// fallback (handled separately in normalizePost). `b` = base (title/permalink/sub) to keep, useful for
// crossposts, where the media comes from the PARENT post but the metadata stays that of the original post.
function extractMedia(p, b) {
  // Reddit gallery
  if (p.is_gallery && p.gallery_data && p.media_metadata) {
    const images = [];
    for (const item of p.gallery_data.items ?? []) {
      const meta = p.media_metadata[item.media_id];
      if (!meta || meta.status !== 'valid' || !meta.s) continue;
      if (meta.e === 'AnimatedImage') {
        const src = decode(meta.s.gif || meta.s.mp4);
        if (src) images.push({ type: 'gif', src });
      } else {
        const src = decode(meta.s.u);
        if (src) images.push({ type: 'image', src });
      }
    }
    return images.length ? { ...b, type: 'gallery', images } : null;
  }

  // Reddit video (v.redd.it)
  if (p.is_video && p.media?.reddit_video) {
    const rv = p.media.reddit_video;
    return { ...b, type: 'video', hls: decode(rv.hls_url || null), mp4: decode(rv.fallback_url || null), poster: pickPreview(p) };
  }

  // Video preview (redgifs/gfycat). We PREFER the MP4 (clean duration => scrub + progress bar
  // OK, and "pause that loops" holds): the HLS of these previews returns a duration of Infinity and an
  // empty seekable range to Safari, which breaks scrub/bar. These previews are almost always muted, so
  // we don't lose any sound. HLS fallback only when there is no MP4.
  if (p.preview?.reddit_video_preview) {
    const rv = p.preview.reddit_video_preview;
    const mp4 = decode(rv.fallback_url || null);
    return { ...b, type: 'video', hls: mp4 ? null : decode(rv.hls_url || null), mp4, poster: pickPreview(p) };
  }

  // Direct media by URL
  const url = p.url_overridden_by_dest || p.url || '';
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.gifv')) return { ...b, type: 'video', hls: null, mp4: url.replace(/\.gifv(\?.*)?$/i, '.mp4$1'), poster: pickPreview(p) };
  if (path.endsWith('.gif')) return { ...b, type: 'gif', src: url };
  if (/\.(jpe?g|png|webp|bmp)$/.test(path)) return { ...b, type: 'image', src: url };
  if (p.post_hint === 'image') return { ...b, type: 'image', src: pickPreview(p) || url };

  return null;
}

function normalizePost(child) {
  if (!child || child.kind !== 't3' || !child.data) return null;
  const p = child.data;
  const b = base(p);

  // 1) Direct media from the post.
  const direct = extractMedia(p, b);
  if (direct) return direct;

  // 2) CROSSPOST: the real media is in the PARENT post (reposted). We take it, keeping the
  //    title / permalink / subreddit of the original post (b). Otherwise a video crosspost would show as a
  //    still image (its preview) instead of the real video, common in Home/Popular.
  const xp = p.crosspost_parent_list && p.crosspost_parent_list[0];
  if (xp) { const m = extractMedia(xp, b); if (m) return m; }

  // 3) Fallback: external link (article, etc.) WITH a Reddit preview image (makes the "link" subs
  //    work: r/entertainment, r/news, etc.). We skip text posts (is_self).
  if (!p.is_self) {
    const prev = pickPreview(p);
    if (prev) return { ...b, type: 'image', src: prev };
  }

  return null; // nothing visual
}

function normalizeSaved(children) {
  return (children || []).map(normalizePost).filter(Boolean);
}

  var VIEWER_URL = "https://zaaphod42.github.io/reddirama/";
  var VIEWER_ORIGIN = "https://zaaphod42.github.io";

  // ---- fetching the saved items (Reddit session) + opening the viewer ----
  function fetchJson(url) {
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
      if (btn && btn.id === 'rss-launch') { btn.textContent = '\u2192 Allow pop-ups, then retry'; setTimeout(function () { btn.textContent = orig; }, 3000); }
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
    var m = p.match(/^\/r\/([A-Za-z0-9_]+)(?:\/|$)/);
    if (m) return { tag: 'r/', id: 'feed:/r/' + m[1] + '/', label: 'r/' + m[1], kind: 'feed' };
    m = p.match(/^\/(?:user|u)\/([A-Za-z0-9_-]+)(?:\/|$)/);
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
  if (document.body) new MutationObserver(addButton).observe(document.body, { childList: true });
})();

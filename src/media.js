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
    // Interaction state carried from Reddit so the viewer can show the right bookmark
    // (saved) and remember the current vote (likes: true=up, false=down, null=none) for the
    // swipe-to-vote toggle. dir is the numeric vote used by the /api/vote endpoint (1/0/-1).
    saved: !!p.saved,
    dir: p.likes === true ? 1 : (p.likes === false ? -1 : 0),
    archived: !!p.archived,   // Reddit auto-archives after ~6 months: voting is closed (the viewer greys the up/down buttons)
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

export function normalizePost(child) {
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

export function normalizeSaved(children) {
  return (children || []).map(normalizePost).filter(Boolean);
}

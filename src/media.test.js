// test/media.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePost, normalizeSaved } from './media.js';

function t3(data) { return { kind: 't3', data: { permalink: '/r/x/comments/1/p/', subreddit: 'x', author: 'a', title: 'T', ...data } }; }

test('ignores comments (t1) and non-t3', () => {
  assert.equal(normalizePost({ kind: 't1', data: {} }), null);
  assert.equal(normalizePost(null), null);
});

test('direct image by extension', () => {
  const m = normalizePost(t3({ name: 't3_1', url: 'https://i.redd.it/abc.jpg' }));
  assert.equal(m.type, 'image');
  assert.equal(m.src, 'https://i.redd.it/abc.jpg');
  assert.equal(m.permalink, 'https://www.reddit.com/r/x/comments/1/p/');
  assert.equal(m.subreddit, 'r/x');
});

test('image via post_hint', () => {
  const m = normalizePost(t3({ name: 't3_2', post_hint: 'image', url: 'https://ex.com/p', preview: { images: [{ source: { url: 'https://prev/i.jpg?s=1&amp;t=2' } }] } }));
  assert.equal(m.type, 'image');
  assert.equal(m.src, 'https://prev/i.jpg?s=1&t=2'); // &amp; decoded
});

test('gif by extension', () => {
  const m = normalizePost(t3({ name: 't3_3', url: 'https://i.redd.it/a.gif' }));
  assert.equal(m.type, 'gif');
});

test('Reddit gallery -> images (with animated gif)', () => {
  const m = normalizePost(t3({
    name: 't3_4', is_gallery: true,
    gallery_data: { items: [{ media_id: 'A' }, { media_id: 'B' }, { media_id: 'C' }] },
    media_metadata: {
      A: { status: 'valid', e: 'Image', s: { u: 'https://prev/a.jpg?w=1&amp;h=2' } },
      B: { status: 'valid', e: 'AnimatedImage', s: { gif: 'https://prev/b.gif', mp4: 'https://prev/b.mp4' } },
      C: { status: 'failed' }, // ignored
    },
  }));
  assert.equal(m.type, 'gallery');
  assert.equal(m.images.length, 2);
  assert.deepEqual(m.images[0], { type: 'image', src: 'https://prev/a.jpg?w=1&h=2' });
  assert.equal(m.images[1].type, 'gif');
  assert.equal(m.images[1].src, 'https://prev/b.gif');
});

test('text post with no media -> ignored', () => {
  assert.equal(normalizePost(t3({ name: 't3_5', is_self: true, url: 'https://www.reddit.com/r/x/comments/1/p/' })), null);
});

test('external link with preview image -> image (link subs)', () => {
  const m = normalizePost(t3({ name: 't3_link', post_hint: 'link', url: 'https://variety.com/article', preview: { images: [{ source: { url: 'https://prev/og.jpg?w=1&amp;s=2' } }] } }));
  assert.equal(m.type, 'image');
  assert.equal(m.src, 'https://prev/og.jpg?w=1&s=2');
});

test('external link with no preview -> ignored', () => {
  assert.equal(normalizePost(t3({ name: 't3_link2', post_hint: 'link', url: 'https://variety.com/article' })), null);
});

test('video crosspost -> media taken from the parent, title/permalink from the original post', () => {
  const m = normalizePost(t3({
    name: 't3_xp', title: 'reposted here',
    crosspost_parent_list: [{ is_video: true, media: { reddit_video: { hls_url: 'https://v/HLS.m3u8', fallback_url: 'https://v/f.mp4' } } }],
  }));
  assert.equal(m.type, 'video');
  assert.equal(m.hls, 'https://v/HLS.m3u8');
  assert.equal(m.title, 'reposted here');
  assert.equal(m.permalink, 'https://www.reddit.com/r/x/comments/1/p/');
});

test('normalizeSaved maps and filters', () => {
  const arr = normalizeSaved([
    t3({ name: 't3_a', url: 'https://i.redd.it/a.jpg' }),
    { kind: 't1', data: {} },
    t3({ name: 't3_b', is_self: true, url: 'https://x' }),
  ]);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].id, 't3_a');
});

test('Reddit v.redd.it video uses hls_url + mp4 fallback', () => {
  const m = normalizePost(t3({
    name: 't3_v1', is_video: true,
    media: { reddit_video: { hls_url: 'https://v/h.m3u8?a=1&amp;b=2', fallback_url: 'https://v/f.mp4' } },
    preview: { images: [{ source: { url: 'https://prev/p.jpg' } }] },
  }));
  assert.equal(m.type, 'video');
  assert.equal(m.hls, 'https://v/h.m3u8?a=1&b=2');
  assert.equal(m.mp4, 'https://v/f.mp4');
  assert.equal(m.poster, 'https://prev/p.jpg');
});

test('video preview (redgifs) via reddit_video_preview: MP4 preferred, HLS discarded', () => {
  const m = normalizePost(t3({
    name: 't3_v2', url: 'https://redgifs.com/watch/abc',
    preview: { reddit_video_preview: { hls_url: 'https://v/HLS.m3u8', fallback_url: 'https://v/r.mp4' }, images: [{ source: { url: 'https://prev/r.jpg' } }] },
  }));
  assert.equal(m.type, 'video');
  assert.equal(m.mp4, 'https://v/r.mp4');
  assert.equal(m.hls, null); // HLS discarded because an MP4 (clean duration, scrub OK) exists
});

test('imgur .gifv -> mp4 video', () => {
  const m = normalizePost(t3({ name: 't3_v3', url: 'https://i.imgur.com/x.gifv' }));
  assert.equal(m.type, 'video');
  assert.equal(m.mp4, 'https://i.imgur.com/x.mp4');
});

test('imgur .gifv with query string -> mp4 keeping the query', () => {
  const m = normalizePost(t3({ name: 't3_v4', url: 'https://i.imgur.com/x.gifv?ref=abc' }));
  assert.equal(m.type, 'video');
  assert.equal(m.mp4, 'https://i.imgur.com/x.mp4?ref=abc');
});

test('malformed gallery (missing items) -> ignored without crashing', () => {
  const m = normalizePost(t3({ name: 't3_g1', is_gallery: true, gallery_data: {}, media_metadata: {} }));
  assert.equal(m, null);
});

test('gallery with no usable image -> ignored', () => {
  const m = normalizePost(t3({
    name: 't3_g0', is_gallery: true,
    gallery_data: { items: [{ media_id: 'A' }] },
    media_metadata: { A: { status: 'valid', e: 'Image', s: {} } }, // s.u missing
  }));
  assert.equal(m, null);
});

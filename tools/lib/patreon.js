'use strict';
// Patreon news cards.
//
// A feed slot { kind: "patreon", rule: { index }, exclude?, noImage?, overrides? }
// shows the n-th newest post of the Patreon page. The launcher doesn't know this
// kind: its resolveFeed renders any unknown slot as a custom card from the slot's
// own top-level fields. So on save the tool "bakes" the post into those fields
// (title, date, imageUrl, …), and every launcher, old or new, shows it unchanged.
//
// Patreon's image URLs are signed and expire after a few weeks, so on save the
// preview image is downloaded into assets/news/ (uploaded to R2 with the campaign
// deploy) and the card points at the R2 copy. Locked posts only expose a blurred
// preview unless the post has a public preview; either is used as is.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ASSETS_DIR, R2_BASE } = require('./config');
const { formatDate } = require('./news');

const API = 'https://www.patreon.com/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const POST_COUNT = 20;
const NEWS_ASSETS = path.join(ASSETS_DIR, 'news');

// Every card field a slot's top level can carry; all of it is derived on a patreon slot.
const CARD_KEYS = ['title', 'excerpt', 'highlights', 'imageUrl', 'badge', 'badgeColor', 'linkUrl', 'date', 'type',
  'imageText', 'imageLabel', 'imageBg', 'imageAccent', 'readMoreLabel', 'patreonId'];

async function getJson(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Patreon answered ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'Patreon did not answer in time' : err.message);
  } finally { clearTimeout(timer); }
}

const campaignIds = new Map();
let cached = null; // { vanity, posts }

// Newest first: [{ id, title, date, url, imageUrl, imageKey, locked }].
async function loadPatreonPosts({ vanity, refresh = false } = {}) {
  if (!vanity) throw new Error('No Patreon page configured');
  if (!refresh && cached?.vanity === vanity) return cached.posts;
  if (!campaignIds.has(vanity)) {
    const r = await getJson(`${API}/campaigns?filter%5Bvanity%5D=${encodeURIComponent(vanity)}&fields%5Bcampaign%5D=name`);
    const id = r?.data?.[0]?.id;
    if (!id) throw new Error(`No Patreon page named "${vanity}"`);
    campaignIds.set(vanity, id);
  }
  const q = [
    `filter%5Bcampaign_id%5D=${campaignIds.get(vanity)}`,
    'filter%5Bcontains_exclusive_posts%5D=true', 'filter%5Bis_draft%5D=false',
    'sort=-published_at', `page%5Bcount%5D=${POST_COUNT}`,
    'fields%5Bpost%5D=title,published_at,url,image,current_user_can_view',
    'json-api-use-default-includes=false', 'json-api-version=1.0',
  ].join('&');
  const r = await getJson(`${API}/posts?${q}`);
  const posts = (r?.data ?? []).map(normalizePost).filter((p) => p.title && p.url);
  cached = { vanity, posts };
  return posts;
}

function normalizePost(p) {
  const a = p.attributes ?? {};
  const imageUrl = a.image?.large_url || a.image?.url || null;
  return {
    id: String(p.id),
    title: String(a.title ?? '').trim(),
    date: a.published_at ?? '',
    url: a.url ?? '',
    imageUrl,
    // The path up to the query string identifies the image; it changes when the image does.
    imageKey: imageUrl ? imageUrl.split('?')[0] : null,
    locked: a.current_user_can_view === false,
  };
}

// Which post each patreon slot shows. Map slotIndex → post.
function selectPatreonPosts(feed, posts) {
  const used = new Set(), picked = new Map();
  (Array.isArray(feed) ? feed : []).forEach((slot, i) => {
    if (slot?.kind !== 'patreon') return;
    const pool = posts.filter((p) => !(slot.exclude === 'used' && used.has(p.id)));
    const p = pool[Math.max(1, Number(slot.rule?.index) || 1) - 1];
    if (p) { picked.set(i, p); used.add(p.id); }
  });
  return picked;
}

// Downloads the post image into assets/news/ once; returns its R2 URL.
async function rehostImage(post) {
  const ext = (/\.(png|jpe?g|webp|gif)$/i.exec(post.imageKey) || [, 'png'])[1].toLowerCase();
  const hash = crypto.createHash('sha1').update(post.imageKey).digest('hex').slice(0, 8);
  const file = `patreon-${post.id}-${hash}.${ext}`;
  const abs = path.join(NEWS_ASSETS, file);
  if (!fs.existsSync(abs)) {
    const res = await fetch(post.imageUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`image download failed (${res.status})`);
    fs.mkdirSync(NEWS_ASSETS, { recursive: true });
    fs.writeFileSync(abs, Buffer.from(await res.arrayBuffer()));
  }
  return `${R2_BASE}/assets/news/${file}`;
}

/**
 * Writes each patreon slot's card fields from its post, in place.
 * posts: from loadPatreonPosts (an empty list means Patreon was unreachable).
 * rehost: download images to assets/news/ (save) or keep Patreon's signed URL (preview).
 * Returns warnings. A slot whose post can't be determined keeps the fields it had.
 */
async function bakePatreonSlots(feed, posts, { rehost = false, download = rehostImage } = {}) {
  const warnings = [];
  const slots = (Array.isArray(feed) ? feed : []).map((s, i) => [s, i]).filter(([s]) => s?.kind === 'patreon');
  if (!slots.length) return warnings;
  if (!posts.length) {
    warnings.push('Patreon could not be reached: Patreon cards keep what they showed before.');
    return warnings;
  }
  const picked = selectPatreonPosts(feed, posts);
  for (const [slot, i] of slots) {
    const post = picked.get(i);
    const where = slot.id || `card ${i + 1}`;
    if (!post) { warnings.push(`${where}: Patreon has no post #${Number(slot.rule?.index) || 1}; the card keeps what it showed before.`); continue; }
    let imageUrl = null;
    if (post.imageUrl && !slot.noImage) {
      try { imageUrl = rehost ? await download(post) : post.imageUrl; }
      catch (err) { warnings.push(`${where}: ${err.message}; the card uses the text header.`); }
    }
    for (const k of CARD_KEYS) delete slot[k];
    Object.assign(slot, {
      patreonId: post.id,
      type: 'update',
      title: post.title,
      date: formatDate(post.date, 'en'),
      excerpt: '',
      linkUrl: post.url,
      badge: 'Patreon',
      ...(imageUrl ? { imageUrl } : {}),
    });
    for (const [k, v] of Object.entries(slot.overrides ?? {})) {
      if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) slot[k] = v;
    }
    if (Array.isArray(slot.highlights) && slot.highlights.length && !slot.overrides?.type) slot.type = 'patchnotes';
  }
  return warnings;
}

module.exports = { loadPatreonPosts, selectPatreonPosts, bakePatreonSlots, rehostImage, normalizePost, NEWS_ASSETS };

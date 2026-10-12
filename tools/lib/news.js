// ═══════════════════════════════════════════════════════════════════════════
// News feed resolution: turns news-feed.json `feed` slots into the cards the
// renderer shows, filling "post" slots from the site's postList.json.
// Copied from the launcher (sc-evo-launcher electron/news/posts.js); copy it again
// after changes there instead of editing this file. test/news-sync.test.js fails
// when the two drift apart.
// ═══════════════════════════════════════════════════════════════════════════
const SITE_BASE = "https://scevo.org";
const POST_LIST_PATH = "/assets/data/postList.json";
const AUTHORS_PATH = "/assets/data/authors.json";

// Patreon posts don't carry an author; they're written by Kat unless a slot says otherwise.
const PATREON_AUTHOR = "Kat";

// Launcher language → site locale. Missing (and en) means the English post.
const SITE_LOCALES = { es: "esES", ko: "koKR", zh: "zhCN", ru: "ruRU", it: "itIT" };

const EXCERPT_MAX = 180;

// "Bug Fixes" = "Bugfixes", "New Models" = "New Model".
const normTag = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
const splitTags = (s) => (Array.isArray(s) ? s : String(s || "").split(",")).map((t) => t.trim()).filter(Boolean);
const absUrl = (u) => (!u ? undefined : /^https?:\/\//i.test(u) ? u : SITE_BASE + (u.startsWith("/") ? u : "/" + u));
const slugOf = (link) => String(link || "").split("/").pop().replace(/\.html?$/i, "");

// Newest first; the list is oldest first, so later entries win ties.
function sortPosts(list) {
  return (Array.isArray(list) ? list : [])
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p && p.link && p.title)
    .sort((a, b) => String(b.p.date || "").localeCompare(String(a.p.date || "")) || b.i - a.i)
    .map(({ p }) => p);
}

// rule: { tag?, index? (1 = newest match) }. exclude "used" skips posts shown by earlier slots.
function pickPost(posts, rule = {}, used = new Set(), exclude) {
  const want = rule.tag ? normTag(rule.tag) : null;
  const matches = posts.filter((p) =>
    (!want || splitTags(p.tags).some((t) => normTag(t) === want)) && !(exclude === "used" && used.has(p.link)));
  const n = Math.max(1, Number(rule.index) || 1);
  return matches[n - 1] || null;
}

function parseFrontMatter(text) {
  const s = String(text || "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(s);
  if (!m) return { meta: {}, body: s };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return { meta, body: s.slice(m[0].length) };
}

// First real paragraph of a post body, as plain text.
function excerptFrom(body, max = EXCERPT_MAX) {
  const blocks = String(body || "").replace(/\r\n/g, "\n").split(/\n\s*\n/);
  for (const raw of blocks) {
    const b = raw.trim();
    if (!b || /^(#|\*{3}|-{3}|\{\{|<|!\[|\||>)/.test(b)) continue;
    const text = b
      .replace(/\{\{[\s\S]*?\}\}/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 20) continue;
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).replace(/[,.;:\s]+$/, "") + "…";
  }
  return "";
}

function formatDate(iso, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return iso || "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  try { return new Intl.DateTimeFormat(lang || "en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(d); }
  catch { return iso; }
}

const OVERRIDE_KEYS = ["title", "excerpt", "highlights", "imageUrl", "badge", "badgeColor", "linkUrl", "date", "type",
  "imageText", "imageLabel", "imageBg", "imageAccent", "readMoreLabel", "author"];

// Author key ("Kat", "HyperONE"…) → { author, authorIcon } from the site's authors.json
// ({ Kat: { name: "Angel \"Kat\" Huerta", icon: "/assets/img/…" } }). Keys match
// case-insensitively; an unknown key is shown as written.
function resolveAuthor(key, authors) {
  const k = String(key || "").trim();
  if (!k) return {};
  const map = authors && typeof authors === "object" ? authors : {};
  const hit = map[k] || map[Object.keys(map).find((n) => n.toLowerCase() === k.toLowerCase())];
  const out = { author: hit?.name || k };
  const icon = absUrl(hit?.icon);
  if (icon) out.authorIcon = icon;
  return out;
}
const pickDefined = (o, keys) => {
  const out = {};
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) out[k] = v;
  }
  return out;
};

// One "post" slot → card. detail: { title, tags, excerpt } in the wanted language (optional).
// tagNames: { "Update": "Actualización", … } for the wanted language (optional).
function postCard(slot, post, { lang = "en", detail = null, tagNames = null, authors = null } = {}) {
  const tags = splitTags(post.tags);
  const ruleTag = slot.rule?.tag ? tags.find((t) => normTag(t) === normTag(slot.rule.tag)) || slot.rule.tag : null;
  const badgeEn = ruleTag || tags[0];
  const localTags = detail?.tags ? splitTags(detail.tags) : null;
  const badge = badgeEn && (tagNames?.[badgeEn]
    || (localTags && localTags.length === tags.length ? localTags[tags.indexOf(badgeEn)] : null)
    || badgeEn);
  const card = {
    id: slot.id || `post-${slugOf(post.link)}`,
    type: "update",
    title: detail?.title || post.title,
    date: formatDate(post.date, lang),
    excerpt: detail?.excerpt || post.description || "",
    imageUrl: absUrl(post["blog-image"] || post.image),
    badge,
    linkUrl: absUrl(post.link),
    post: post.link,
    ...resolveAuthor(detail?.author || post.author, authors),
  };
  if (slot.variant) card.variant = slot.variant;
  return card;
}

// Applies overrides, then the slot's locales for `lang` (when applyLocales), and the card type rules.
function finishCard(card, slot, { lang, applyLocales, authors = null }) {
  const out = { ...card, ...pickDefined(slot.overrides, OVERRIDE_KEYS) };
  if (applyLocales) {
    Object.assign(out, pickDefined(slot.locales?.[lang], OVERRIDE_KEYS));
    delete out.locales;
  } else if (slot.locales && Object.keys(slot.locales).length) {
    out.locales = slot.locales;
  }
  // An overridden author is a key ("Kat"); turn it into the display name and icon.
  const authorKey = (applyLocales && slot.locales?.[lang]?.author) || slot.overrides?.author;
  if (authorKey) { delete out.authorIcon; Object.assign(out, resolveAuthor(authorKey, authors)); }
  if (!slot.overrides?.type && Array.isArray(out.highlights) && out.highlights.length) out.type = "patchnotes";
  return out;
}

// Which post each "post" slot shows (language-independent). Returns Map slotIndex → post.
function selectPosts(feed, posts) {
  const used = new Set(), picked = new Map();
  (Array.isArray(feed) ? feed : []).forEach((slot, i) => {
    if (slot?.kind !== "post") return;
    const p = pickPost(posts, slot.rule, used, slot.exclude);
    if (p) { picked.set(i, p); used.add(p.link); }
  });
  return picked;
}

// feed + sorted posts → cards. details: Map link → { title, tags, excerpt, author } for `lang`.
// authors: the site's authors.json, for author display names and icons.
// applyLocales: the launcher applies locales itself (true); the old-launcher snapshot keeps them (false).
// withSlot adds `slot` (the feed index) to each card, for editors.
function resolveFeed(feed, posts, { lang = "en", details = new Map(), tagNames = null, authors = null, applyLocales = true, withSlot = false } = {}) {
  const picked = selectPosts(feed, posts);
  const cards = [];
  const push = (card, i) => cards.push(withSlot ? { ...card, slot: i } : card);
  (Array.isArray(feed) ? feed : []).forEach((slot, i) => {
    if (!slot || slot.enabled === false) return;
    if (slot.kind === "post") {
      const post = picked.get(i);
      if (!post) return;
      push(finishCard(postCard(slot, post, { lang, detail: details.get(post.link), tagNames, authors }), slot, { lang, applyLocales, authors }), i);
    } else if (slot.kind === "banner") {
      const card = { id: slot.id, type: "banner", imageUrl: slot.imageUrl, linkUrl: slot.linkUrl, title: slot.title };
      if (slot.variant) card.variant = slot.variant;
      const out = finishCard(card, { ...slot, overrides: null }, { lang, applyLocales });
      out.type = "banner";
      if (out.imageUrl) push(out, i);
    } else {
      const { kind, overrides, enabled, ...rest } = slot;
      const out = { ...rest };
      if (applyLocales) { Object.assign(out, pickDefined(slot.locales?.[lang], OVERRIDE_KEYS)); delete out.locales; }
      const authorKey = out.author || overrides?.author || (kind === "patreon" ? PATREON_AUTHOR : null);
      if (authorKey) { delete out.authorIcon; Object.assign(out, resolveAuthor(authorKey, authors)); }
      push(out, i);
    }
  });
  return cards;
}

// ─── Fetching ───
// fetch: WHATWG-style fetch. cache: { get(key), set(key, value) } for offline fallback (optional).
function createNewsResolver({ fetch, cache = null, base = SITE_BASE, timeoutMs = 8000 } = {}) {
  const mem = new Map();

  async function getText(url) {
    if (mem.has(url)) return mem.get(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      const text = res.ok ? await res.text() : null;
      // Only successes are remembered: one failed request must not blank the
      // news for the rest of the session.
      if (text !== null) mem.set(url, text);
      return text;
    } finally { clearTimeout(timer); }
  }

  async function loadPosts() {
    try {
      const text = await getText(base + POST_LIST_PATH);
      if (text) {
        const list = JSON.parse(text.replace(/^﻿/, ""));
        if (Array.isArray(list)) { cache?.set("postList", list); return sortPosts(list); }
      }
    } catch { /* offline: fall back to the cache */ }
    return sortPosts(cache?.get("postList") || []);
  }

  // { title, tags, excerpt } from the post's markdown in `lang`, falling back to English.
  async function loadDetail(post, lang) {
    const slug = slugOf(post.link);
    const loc = SITE_LOCALES[lang];
    const key = `post:${slug}:${loc || "en"}`;
    try {
      let text = loc ? await getText(`${base}/posts/${slug}.${loc}.md`).catch(() => null) : null;
      const localized = !!text;
      if (!text) text = await getText(`${base}/posts/${slug}.md`);
      if (!text) return cache?.get(key) || null;
      const { meta, body } = parseFrontMatter(text);
      const detail = {
        title: localized ? meta.title : null,
        tags: localized ? meta.tags : null,
        author: meta.author || null,
        excerpt: (localized ? meta.description : null) || (localized || !post.description ? excerptFrom(body) : null),
      };
      cache?.set(key, detail);
      return detail;
    } catch {
      return cache?.get(key) || null;
    }
  }

  async function loadTagNames(lang) {
    const loc = SITE_LOCALES[lang];
    if (!loc) return null;
    try {
      const text = await getText(`${base}/assets/data/locales/${loc}.tags.json`);
      if (text) { const names = JSON.parse(text); cache?.set(`tags:${loc}`, names); return names; }
    } catch { /* fall through */ }
    return cache?.get(`tags:${loc}`) || null;
  }

  // { Kat: { name, icon, … }, … } from the site, falling back to the cache.
  async function loadAuthors() {
    try {
      const text = await getText(base + AUTHORS_PATH);
      if (text) {
        const authors = JSON.parse(text.replace(/^﻿/, ""));
        if (authors && typeof authors === "object") { cache?.set("authors", authors); return authors; }
      }
    } catch { /* fall through */ }
    return cache?.get("authors") || null;
  }

  async function resolve(feed, lang = "en", { applyLocales = true, withSlot = false } = {}) {
    const posts = await loadPosts();
    const picked = [...selectPosts(feed, posts).values()];
    const [detailList, tagNames, authors] = await Promise.all([
      Promise.all(picked.map((p) => loadDetail(p, lang))),
      loadTagNames(lang),
      loadAuthors(),
    ]);
    const details = new Map(picked.map((p, i) => [p.link, detailList[i]]));
    return { cards: resolveFeed(feed, posts, { lang, details, tagNames, authors, applyLocales, withSlot }), posts };
  }

  return { resolve, loadPosts, loadDetail, loadTagNames, loadAuthors, clear: () => mem.clear() };
}

module.exports = {
  SITE_BASE, SITE_LOCALES, PATREON_AUTHOR,
  normTag, resolveAuthor, splitTags, sortPosts, pickPost, selectPosts, parseFrontMatter, excerptFrom, formatDate,
  postCard, resolveFeed, createNewsResolver,
};

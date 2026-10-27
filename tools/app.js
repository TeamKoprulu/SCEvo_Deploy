'use strict';
// SCEvo Deploy Tool — local HTTP server.
//
// Zero dependencies: node:http, node:fs, node:crypto, node:child_process only.
// Start with run.cmd. Binds to loopback with a per-run token so nothing on the
// network can trigger a build or a deploy.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const cfg = require('./lib/config');
const hashcache = require('./lib/hashcache');
const mf = require('./lib/manifest');
const catalog = require('./lib/catalog');
const builder = require('./lib/build');
const { generate } = require('./lib/generate');
const { deploy } = require('./lib/deploy');
const mapcache = require('./lib/mapcache');
const verify = require('./lib/verify');
const r2 = require('./lib/r2');
const news = require('./lib/news');
const patreon = require('./lib/patreon');

const UI_DIR = path.join(__dirname, 'ui');
const TOKEN = crypto.randomBytes(16).toString('hex');

// Named per-port because cookies ignore the port component — two instances on
// different ports would otherwise clobber each other's token. Assigned once the
// server is listening; no request can arrive before that.
let COOKIE_NAME = 'scevo';

let NEWS_RESOLVER = null;
const newsResolver = () => (NEWS_RESOLVER ??= news.createNewsResolver({ fetch }));

const patreonVanity = () => cfg.readConfig().patreonVanity || cfg.DEFAULT_PATREON_VANITY;
// Patreon posts, or [] with the reason when Patreon can't be reached.
async function patreonPosts(refresh = false) {
  try { return { posts: await patreon.loadPatreonPosts({ vanity: patreonVanity(), refresh }), error: null }; }
  catch (err) { return { posts: [], error: err.message }; }
}
// A patreon slot renders as a custom card, which carries the slot's whole top level; drop the editor-only keys.
const stripSlotRule = ({ rule, exclude, noImage, ...card }) => card;

// Launchers up to 1.3.1 colour the badge from badgeColor only, so an "Accent
// (header + badge)" without a Badge colour is written to badgeColor as well.
// Post and Patreon slots keep both in overrides; Patreon bakes them afterwards.
function linkBadgeColor(slot) {
  const t = slot?.kind === 'post' || slot?.kind === 'patreon' ? slot.overrides : slot;
  if (t?.imageAccent && !t.badgeColor) t.badgeColor = t.imageAccent;
}

/* ── SSE bus ─────────────────────────────────────────────────────────────── */

const clients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch {} }
}

let currentJob = null;

// Runs an exclusive job, streaming progress. Only one at a time — packaging and
// deploying concurrently would race on the same payload files.
async function runJob(name, fn) {
  if (currentJob) throw Object.assign(new Error(`Busy: "${currentJob}" is already running`), { status: 409 });
  currentJob = name;
  broadcast({ type: 'job-start', job: name });
  const log = (message) => broadcast({ type: 'log', job: name, message });
  const progress = (data) => broadcast({ type: 'progress', job: name, ...data });
  // Explicit stage boundaries. The UI used to infer these by regex-matching log
  // text, which silently broke the moment a message was reworded.
  const step = (id, state, detail) => broadcast({ type: 'step', job: name, step: id, state, detail: detail ?? null });
  try {
    const result = await fn({ log, progress, step });
    broadcast({ type: 'job-done', job: name });
    return result;
  } catch (err) {
    broadcast({ type: 'job-error', job: name, message: err.message });
    throw err;
  } finally {
    currentJob = null;
    hashcache.flush();
  }
}

/* ── route handlers ──────────────────────────────────────────────────────── */

const MANIFEST_BRANCHES = ['public', 'beta', 'melee', 'meleebeta'];
const packageOfBranch = (b) => b === 'melee' ? 'melee' : b === 'meleebeta' ? 'meleebeta' : 'campaign';

// What the Melee tab's lobby preview needs: the map pool (the generated melee manifest when given,
// else the written one; the melee beta plays the public pool) with thumbnail URLs, the public
// colour (the campaign's public accent, as the launcher uses) and the melee beta's state.
function meleePreview(generated) {
  const melee = generated ?? mf.readManifest(cfg.MELEE_MANIFEST);
  const beta = mf.readManifest(cfg.MELEE_BETA_MANIFEST);
  return {
    maps: (melee?.maps ?? []).map((m) => ({
      id: m.id, name: m.name, description: m.description ?? '', modes: m.modes ?? '', players: m.players ?? 0,
      size: m.size ?? null, tileset: m.tileset ?? null,
      thumb: m.thumbnail?.path && fs.existsSync(path.join(cfg.MELEE_DIR, m.thumbnail.path)) ? `/melee-thumb/${m.id}.png` : null,
    })),
    publicAccent: mf.readManifest(cfg.PUBLIC_MANIFEST)?.theme?.accentColor || null,
    betaEnabled: !!beta?.betaEnabled,
    betaAccent: beta?.theme?.accentColor || '#ff6600',
  };
}

const routes = {
  // Deliberately cheap — no network. The R2 probe costs up to 15s and lives on
  // /api/probe so the shell can paint immediately and fill the R2 chip in later.
  'GET /api/state': async () => {
    const c = cfg.readConfig();
    const rc = await r2.rcloneAvailable();
    const remotes = rc.ok ? await r2.rcloneRemotes() : [];
    return {
      config: {
        sc2InstallPath: c.sc2InstallPath ?? '',
        launcherRepoPath: c.launcherRepoPath ?? '',
        siteRepoPath: c.siteRepoPath ?? '',
        sc2AssetsPath: c.sc2AssetsPath ?? '',
        sc2GameDataPath: c.sc2GameDataPath ?? '',
        cdnBase: c.cdnBase ?? '',
        showVersionDebug: c.showVersionDebug === true,
      },
      decalDefaults: require('./lib/decals').DEFAULT_PATHS,
      paths: {
        repoRoot: cfg.REPO_ROOT,
        sc2Valid: !!(c.sc2InstallPath && fs.existsSync(c.sc2InstallPath)),
        launcherValid: !!(c.launcherRepoPath && fs.existsSync(path.join(c.launcherRepoPath, 'package.json'))),
        siteValid: require('./lib/site').siteValid(c.siteRepoPath),
        payloadExists: fs.existsSync(cfg.PAYLOAD_DIR),
        betaExists: fs.existsSync(cfg.BETA_DIR),
        meleeExists: fs.existsSync(cfg.MELEE_DIR),
        catalog: fs.existsSync(cfg.CATALOG_PATH),
        mpqEditor: fs.existsSync(cfg.MPQ_EDITOR),
      },
      rclone: { ...rc, remotes, hasCf: remotes.includes('cf:') },
      cache: hashcache.stats(),
      busy: currentJob,
    };
  },

  // Actually talks to Cloudflare. Separate from /api/state so a slow or dead
  // network never delays the UI, and so the strip can re-check on demand.
  'GET /api/probe': async () => {
    const rc = await r2.rcloneAvailable();
    if (!rc.ok) return { probe: { ok: false, status: 'no-rclone', error: rc.error } };
    const remotes = await r2.rcloneRemotes();
    if (!remotes.includes('cf:')) {
      return { probe: { ok: false, status: 'no-bucket', error: 'No "cf:" remote in rclone.conf. Create it with `rclone config`.' } };
    }
    return { probe: await r2.rcloneProbe() };
  },

  'POST /api/config': async (body) => {
    const patch = {};
    for (const key of ['sc2InstallPath', 'launcherRepoPath', 'siteRepoPath', 'sc2AssetsPath', 'sc2GameDataPath', 'cdnBase']) {
      if (typeof body[key] === 'string') patch[key] = body[key].trim();
    }
    if (typeof body.showVersionDebug === 'boolean') patch.showVersionDebug = body.showVersionDebug;
    return { config: cfg.updateConfig(patch) };
  },

  /* ── catalog ───────────────────────────────────────────────── */

  // Every source in the SC2 install with its catalog decision and build status.
  'GET /api/catalog': async () => {
    const c = cfg.readConfig();
    const root = c.sc2InstallPath;
    const doc = catalog.load();
    if (!doc) return { needsInit: true };
    if (!root || !fs.existsSync(root)) return { error: 'SC2 install path is not set or does not exist', rows: [], melee: doc.melee };
    const { rows, missingRoots } = catalog.classify(doc, root);
    const status = builder.statusOf(doc, rows);
    const shipped = new Set(doc.items
      .filter((i) => catalog.channelsOf(i).length && (i.package === 'melee' || catalog.channelsOf(i).includes('public')))
      .map((i) => catalog.targetOf(i).toLowerCase()));
    const out = rows.map((r) => {
      const row = {
        source: r.source, name: path.basename(r.source), group: path.dirname(r.source),
        kind: r.kind, packed: !!r.packed, status: r.status, item: r.item,
        build: r.item ? status.get(catalog.keyOf(r.source)) : null,
        canMeleeBeta: require('./lib/meleebeta').canTag(r.source),
      };
      // Maps under a melee-capable root get their metadata for the map cards.
      const meleeCandidate = r.kind === 'map' && r.abs && (r.item?.package === 'melee' || (r.status !== 'tracked' && /SCEvo_MPMaps/i.test(r.source)));
      if (meleeCandidate) {
        const meta = mapcache.metaFor(r.abs, root);
        row.meta = meta;
        row.autoModes = require('./lib/mapmeta').modesFor(meta.modes, meta.players);
        row.missingMods = (meta.requiresMods || []).filter((m) => !shipped.has(m.toLowerCase()));
      }
      return row;
    });
    return { rows: out, missingRoots, melee: doc.melee, roots: doc.roots, ignoredCount: doc.ignore.length,
      meleeBetaProblems: require('./lib/meleebeta').closureProblems(doc, rows) };
  },

  'GET /api/thumb': async (_b, url) => {
    const root = cfg.readConfig().sc2InstallPath;
    const source = url.searchParams.get('source') || '';
    const abs = path.join(root, source);
    if (!source || !abs.startsWith(root) || !fs.existsSync(abs)) throw Object.assign(new Error('No such map'), { status: 404 });
    const png = mapcache.thumbFor(abs, root);
    if (!png) throw Object.assign(new Error('No thumbnail'), { status: 404 });
    return { __raw: png, __type: 'image/png' };
  },

  'POST /api/catalog-init': async () => {
    if (catalog.load()) throw new Error('deploy-catalog.json already exists');
    const doc = require('./lib/seed').seed();
    catalog.save(doc);
    await builder.adoptExisting(doc, cfg.readConfig().sc2InstallPath);
    return { items: doc.items.length, ignored: doc.ignore.length };
  },

  // body: { source, patch?: { package, channel, meleeBeta, name, description }, ignore?: true|false }
  'POST /api/catalog': async (body) => {
    const doc = catalog.load();
    if (!doc) throw new Error('No catalog yet');
    if (!body.source) throw new Error('Missing source');
    if (body.ignore === true) catalog.ignore(doc, body.source);
    else if (body.ignore === false) catalog.unignore(doc, body.source);
    else {
      const patch = { ...(body.patch || {}) };
      if ('meleeBeta' in patch) {
        if (patch.meleeBeta && !require('./lib/meleebeta').canTag(body.source)) throw new Error('Only mods in "Mods\\SC Evolution Complete" can be tagged for the melee beta');
        patch.meleeBeta = patch.meleeBeta ? true : null;
      }
      catalog.upsert(doc, body.source, patch);
    }
    catalog.save(doc);
    return { item: catalog.findItem(doc, body.source) };
  },

  // body: { packages, only?, force? }  Builds, then regenerates the manifests.
  'POST /api/build': async (body) => runJob('build', async ({ log, progress }) => {
    const doc = catalog.load();
    const sc2Root = cfg.readConfig().sc2InstallPath;
    const packages = (body.packages || catalog.BUILD_PACKAGES).filter((p) => catalog.BUILD_PACKAGES.includes(p));
    const { results, pruned, problems = [] } = await builder.build({ doc, sc2Root, packages, only: body.only || null, force: !!body.force, log, progress });
    const gen = await generate({ doc, sc2Root, packages });
    gen.written.filter((w) => w.changed).forEach((w) => log(`Regenerated ${w.file}`));
    gen.problems.forEach((p) => log(`PROBLEM: ${p}`));
    return { results, pruned, manifests: gen.written, problems: [...problems, ...gen.problems] };
  }),

  /* ── manifests (generated; only the settings are edited) ───── */

  'GET /api/manifest': async (_b, url) => {
    const branch = MANIFEST_BRANCHES.includes(url.searchParams.get('branch')) ? url.searchParams.get('branch') : 'public';
    const doc = catalog.load();
    if (!doc) return { needsInit: true };
    const file = { public: cfg.PUBLIC_MANIFEST, beta: cfg.BETA_MANIFEST, melee: cfg.MELEE_MANIFEST, meleebeta: cfg.MELEE_BETA_MANIFEST }[branch];
    const existing = mf.readManifest(file);
    const gen = await generate({ doc, sc2Root: cfg.readConfig().sc2InstallPath, packages: [packageOfBranch(branch)], dryRun: true });
    const next = gen.docs[branch === 'meleebeta' ? 'meleeBeta' : branch];
    const before = new Map();
    for (const m of (existing?.modules ?? [])) for (const f of (m.files ?? [])) before.set(f.path, f.hash);
    for (const m of (existing?.maps ?? [])) before.set(m.file?.path, m.file?.hash);
    const stateOf = (p, h) => (!before.has(p) ? 'new' : before.get(p) === h ? 'unchanged' : 'changed');
    const entries = [
      ...(next?.modules ?? []).flatMap((m) => m.files.map((f) => ({ kind: 'file', name: m.name, path: f.path, size: f.size, state: stateOf(f.path, f.hash) }))),
      ...(next?.maps ?? []).map((m) => ({ kind: 'map', name: m.name, path: m.file.path, size: m.file.size, players: m.players, state: stateOf(m.file.path, m.file.hash) })),
    ];
    const kept = new Set(entries.map((e) => e.path));
    for (const p of before.keys()) if (p && !kept.has(p)) entries.push({ kind: 'removed', name: path.basename(p), path: p, state: 'removed' });
    return {
      branch,
      exists: !!existing,
      upToDate: !!existing && require('./lib/generate').sameContent(existing, next),
      lastUpdated: existing?.lastUpdated ?? null,
      versions: existing?.versions ?? { multiplayer: '', campaign: '' },
      criticalUpdate: mf.mergeCritical(existing?.criticalUpdate, branch === 'beta'),
      betaMeta: branch === 'beta' ? {
        betaEnabled: !!existing?.betaEnabled, betaName: existing?.betaName ?? '',
        majorVersion: existing?.majorVersion ?? '', fullVersion: existing?.fullVersion ?? '',
        codeHash: existing?.codeHash ?? '', accentColor: existing?.theme?.accentColor ?? '#ff6600',
        coreVersion: existing?.versions?.multiplayer ?? '', episode: existing?.episode ?? null, background: existing?.background ?? null,
        hero: existing?.hero ?? null,
      } : null,
      // Public channel colour (blank = the launcher's built-in site colour) and hero episode.
      publicMeta: branch === 'public' ? { accentColor: existing?.theme?.accentColor ?? '', episode: existing?.episode ?? null, background: existing?.background ?? null, hero: existing?.hero ?? null } : null,
      episodes: require('./lib/episodes').readEpisodes(cfg.readConfig().siteRepoPath),
      meleeVersion: doc.melee.version,
      meleePreview: branch === 'melee' || branch === 'meleebeta' ? meleePreview(branch === 'melee' ? next : null) : null,
      meleeBetaMeta: branch === 'meleebeta' ? {
        betaEnabled: !!existing?.betaEnabled, betaName: existing?.betaName ?? '', version: existing?.version ?? '',
        codeHash: existing?.codeHash ?? '', accentColor: existing?.theme?.accentColor ?? '#ff6600',
      } : null,
      entries,
      problems: gen.problems,
    };
  },

  // Writes the manifest for a branch with the edited settings.
  'POST /api/manifest': async (body) => {
    const branch = MANIFEST_BRANCHES.includes(body.branch) ? body.branch : 'public';
    const doc = catalog.load();
    const overrides = {};
    if (branch === 'meleebeta') {
      const m = body.meleeBetaMeta || {};
      overrides.meleeBeta = { enabled: !!m.betaEnabled, name: m.betaName ?? '', version: m.version ?? '', codeHash: m.codeHash ?? '', accentColor: m.accentColor ?? '' };
    }
    if (branch === 'public') {
      overrides.public = { versions: body.versions, criticalUpdate: body.criticalUpdate };
      if (body.publicMeta) Object.assign(overrides.public, { accentColor: body.publicMeta.accentColor ?? '', episode: body.publicMeta.episode ?? null, background: body.publicMeta.background ?? null, hero: body.publicMeta.hero ?? null });
    }
    if (branch === 'beta') overrides.beta = { meta: body.betaMeta, criticalUpdate: body.criticalUpdate };
    if (branch === 'melee') {
      doc.melee.version = String(body.meleeVersion || doc.melee.version).trim();
      catalog.save(doc);
      overrides.melee = { version: doc.melee.version };
    }
    const gen = await generate({ doc, sc2Root: cfg.readConfig().sc2InstallPath, packages: [packageOfBranch(branch)], overrides });
    return { written: gen.written, problems: gen.problems };
  },

  // A channel's hero background: saved under assets/launcher/ (uploaded with the campaign
  // package, before the manifests), named by its hash so a new image never reuses a cached URL.
  'POST /api/launcher-background': async (body) => require('./lib/backgrounds').saveBackground(body),

  // Hero editor media: a video (plus a still made from it) or a still chosen by hand, saved under
  // assets/hero/. body: { branch, kind: "video"|"poster", filename, data } → { video?, poster }
  'POST /api/hero-media': async (body) => {
    const hero = require('./lib/hero');
    const saved = hero.saveHeroMedia(body);
    if (body.kind !== 'video') return { poster: saved };
    let poster = null, posterError = null;
    try { poster = hero.makePoster({ branch: body.branch, file: saved.file }); } catch (e) { posterError = e.message; }
    return { video: saved, poster, posterError };
  },
  // A new still from a saved hero video, `at` (0–1) of the way in. body: { branch, file, at }
  'POST /api/hero-poster': async (body) => ({ poster: require('./lib/hero').makePoster(body) }),

  'POST /api/beta-code-hash': async (body) => ({ codeHash: mf.betaCodeHash(body.code ?? '') }),

  'POST /api/verify': async (body) => runJob('verify', async ({ progress, step }) => {
    const branch = MANIFEST_BRANCHES.includes(body.branch) ? body.branch : 'public';
    step('checks', 'active', `${branch} manifest`);
    const r = branch === 'melee' ? await verify.preflightMelee(progress)
      : branch === 'meleebeta' ? await verify.preflightMeleeBeta(progress)
      : await verify.preflight(branch, progress);
    step('checks', r.canDeploy ? 'done' : 'failed', `${r.errors} error(s), ${r.warnings} warning(s)`);
    return r;
  }),

  // body: { packages: ['campaign','melee','meleebeta','launcher'], dryRun, force }
  'POST /api/deploy': async (body) => runJob('deploy', async ({ log, progress, step }) => {
    const { DEPLOY_PACKAGES } = require('./lib/deploy');
    const packages = (body.packages || []).filter((p) => DEPLOY_PACKAGES.includes(p));
    return deploy({ packages, dryRun: !!body.dryRun, force: !!body.force, updateSite: !!body.updateSite, log, progress, step });
  }),

  // news-feed.json and assets/news/ only, for a news change between campaign deploys.
  'POST /api/deploy-news': async (body) => runJob('deploy', async ({ log, progress, step }) =>
    require('./lib/deploy').deployNews({ dryRun: !!body.dryRun, force: !!body.force, log, progress, step })),

  'GET /api/remote-orphans': async (_b, url) => {
    const branch = MANIFEST_BRANCHES.includes(url.searchParams.get('branch')) ? url.searchParams.get('branch') : 'public';
    const prefix = { public: 'payload', beta: 'betapayload', melee: 'meleepayload', meleebeta: 'betameleepayload' }[branch];
    const remote = await r2.listRemote(prefix);
    if (!remote.ok) return { ok: false, error: remote.error, orphans: [] };
    const known = new Set();
    if (branch === 'melee') {
      for (const f of verify.meleeFiles(mf.readManifest(cfg.MELEE_MANIFEST))) known.add(String(f.path).toLowerCase());
    } else if (branch === 'meleebeta') {
      for (const f of verify.meleeBetaFiles(mf.readManifest(cfg.MELEE_BETA_MANIFEST))) known.add(String(f.path).toLowerCase());
    } else {
      const doc = mf.readManifest(branch === 'beta' ? cfg.BETA_MANIFEST : cfg.PUBLIC_MANIFEST);
      for (const m of (doc?.modules ?? [])) for (const f of (m.files ?? [])) known.add(f.path.toLowerCase());
    }
    const orphans = remote.items.filter((o) => !known.has(o.path.replace(/\\/g, '/').toLowerCase()));
    return { ok: true, prefix, total: remote.items.length, orphans };
  },

  'POST /api/remote-delete': async (body) => runJob('remote-delete', async ({ log }) => {
    const prefix = ['payload', 'betapayload', 'meleepayload', 'betameleepayload'].includes(body.prefix) ? body.prefix : null;
    if (!prefix) throw new Error('Unknown prefix');
    const results = [];
    for (const p of (body.paths ?? [])) {
      const r = await r2.deleteRemote(prefix, p);
      log(r.ok ? `Deleted ${p}` : `FAILED ${p}: ${r.error}`);
      results.push(r);
    }
    return { results };
  }),

  'GET /api/news': async () => {
    const doc = mf.readManifest(cfg.NEWS_FEED);
    return { exists: !!doc, news: doc ?? null };
  },

  // Site posts for the feed editor: newest first, plus every tag in use.
  'GET /api/site-posts': async (_body, url) => {
    if (url.searchParams.get('refresh')) newsResolver().clear();
    const posts = await newsResolver().loadPosts();
    const tags = [...new Map(posts.flatMap((p) => news.splitTags(p.tags)).map((t) => [news.normTag(t), t])).values()].sort();
    return { posts: posts.map((p) => ({ link: p.link, title: p.title, date: p.date, tags: p.tags })), tags };
  },

  // Patreon posts for the feed editor, newest first.
  'GET /api/patreon-posts': async (_body, url) => {
    const { posts, error } = await patreonPosts(!!url.searchParams.get('refresh'));
    if (error) throw new Error(error);
    return { vanity: patreonVanity(), posts: posts.map(({ id, title, date, url: link, imageUrl, locked }) => ({ id, title, date, url: link, hasImage: !!imageUrl, locked })) };
  },

  // What the launcher would show for this feed in one language; each card carries its feed index.
  // Patreon cards preview with Patreon's own (expiring) image URL; Save re-hosts it.
  'POST /api/news-preview': async (body) => {
    if (!Array.isArray(body.feed)) throw new Error('Missing feed');
    const feed = structuredClone(body.feed);
    // As Save does: a badge that follows the accent gets it, so the preview shows the saved card.
    feed.forEach(linkBadgeColor);
    if (feed.some((s) => s?.kind === 'patreon')) await patreon.bakePatreonSlots(feed, (await patreonPosts()).posts);
    const { cards } = await newsResolver().resolve(feed, body.lang || 'en', { withSlot: true });
    return { cards: cards.map(stripSlotRule) };
  },

  // Merges into the existing file so keys this editor doesn't know (promo, strings,
  // announcement.locales) survive. With a feed, "cards" becomes its English snapshot
  // for launchers that predate the feed.
  'POST /api/news': async (body) => {
    if (!body.news || typeof body.news !== 'object') throw new Error('Missing news payload');
    const prev = mf.readManifest(cfg.NEWS_FEED) ?? {};
    const doc = { ...prev, ...body.news };
    if (prev.announcement && body.news.announcement) doc.announcement = { ...prev.announcement, ...body.news.announcement };
    const warnings = [];
    if (Array.isArray(doc.feed)) doc.feed.forEach(linkBadgeColor);
    if (Array.isArray(doc.feed) && doc.feed.some((s) => s?.kind === 'patreon')) {
      // Fresh posts on every save, so a new Patreon post shows up without restarting the tool.
      warnings.push(...await patreon.bakePatreonSlots(doc.feed, (await patreonPosts(true)).posts, { rehost: true }));
    }
    if (Array.isArray(doc.feed)) {
      newsResolver().clear();
      const { cards, posts } = await newsResolver().resolve(doc.feed, 'en', { applyLocales: false });
      if (!posts.length && doc.feed.some((s) => s.kind === 'post')) {
        warnings.push('scevo.org could not be reached: the snapshot for older launchers keeps its previous cards.');
      } else {
        // Older launchers can't draw image-only cards.
        doc.cards = cards.filter((c) => c.type !== 'banner').map(({ post, ...c }) => stripSlotRule(c));
      }
    }
    doc.lastUpdated = mf.nowIso();
    mf.writeManifest(cfg.NEWS_FEED, doc);
    return { written: path.relative(cfg.REPO_ROOT, cfg.NEWS_FEED), warnings };
  },

  // Offline .zip of the public campaign package (local file only).
  'POST /api/offline-zip': async () => runJob('offline-zip', async ({ log, progress }) => {
    const r = await require('./lib/offline').buildOfflineZip({ log, onProgress: progress });
    return { file: r.file, rel: path.relative(cfg.REPO_ROOT, r.file), bytes: r.bytes, entries: r.entries };
  }),

  // Shows a file the tool wrote in Explorer. Only paths inside this repo.
  'POST /api/open-folder': async (body) => {
    const target = path.resolve(cfg.REPO_ROOT, String(body.path || ''));
    if (!target.startsWith(cfg.REPO_ROOT + path.sep) || !fs.existsSync(target)) throw Object.assign(new Error('Not a file in this repo'), { status: 400 });
    spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return {};
  },

  // Is a custom CDN address ready to replace r2.dev?
  'GET /api/cdn-check': async (_b, url) => require('./lib/cdncheck').cdnCheck(url.searchParams.get('base') || cfg.readConfig().cdnBase || ''),

  // Packages whose local manifests differ from the live ones (what a deploy would publish).
  'GET /api/pending': async () => require('./lib/pending').pendingPackages(),

  'POST /api/cache-prune': async () => ({ removed: hashcache.prune(), cache: hashcache.stats() }),
};

/* ── HTTP plumbing ───────────────────────────────────────────────────────── */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webm': 'video/webm' };

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 << 20) { reject(new Error('Request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`Invalid JSON body: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // Query param first, so the token in the address bar always beats a stale
  // cookie left by an earlier run on this port. The cookie exists because a
  // relative <link href="app.css"> resolves WITHOUT the query string and carries
  // no x-token header — without it every subresource 403s and the page renders
  // as bare unstyled HTML.
  const token = url.searchParams.get('t')
             || req.headers['x-token']
             || readCookie(req, COOKIE_NAME);

  // Static UI
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    if (token !== TOKEN) return send(res, 403, { error: 'Invalid or missing token' });
    // The website's images (episode art for the launcher mock): /site-asset/assets/img/…
    if (url.pathname.startsWith('/site-asset/')) {
      const siteRoot = cfg.readConfig().siteRepoPath;
      const imgRoot = siteRoot ? path.resolve(siteRoot, 'assets', 'img') : null;
      const file = siteRoot ? path.resolve(siteRoot, decodeURIComponent(url.pathname.slice('/site-asset/'.length))) : null;
      if (!file || !file.startsWith(imgRoot + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
      return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'max-age=300' });
    }
    // Hero editor media saved here (assets/hero/), before they reach the CDN: /hero-asset/<file>
    if (url.pathname.startsWith('/hero-asset/')) {
      const abs = require('./lib/hero').fileFor(decodeURIComponent(url.pathname.slice('/hero-asset/'.length)));
      if (!abs || !fs.existsSync(abs)) return send(res, 404, { error: 'Not found' });
      return send(res, 200, fs.readFileSync(abs), { 'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
    }
    // Built melee map thumbnails for the lobby preview: /melee-thumb/<map id>.png
    if (url.pathname.startsWith('/melee-thumb/')) {
      const file = path.basename(decodeURIComponent(url.pathname.slice('/melee-thumb/'.length)));
      const abs = path.join(cfg.MELEE_DIR, 'thumbs', file);
      if (!/^[0-9a-f]{10}\.png$/.test(file) || !fs.existsSync(abs)) return send(res, 404, { error: 'Not found' });
      return send(res, 200, fs.readFileSync(abs), { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=60' });
    }
    // Hero backgrounds saved here but not uploaded yet: /launcher-bg/<file>
    if (url.pathname.startsWith('/launcher-bg/')) {
      const file = path.basename(decodeURIComponent(url.pathname.slice('/launcher-bg/'.length)));
      const abs = path.join(require('./lib/backgrounds').DIR, file);
      if (!/^(public|beta)-[0-9a-f]{12}.(webp|png|jpg)$/.test(file) || !fs.existsSync(abs)) return send(res, 404, { error: 'Not found' });
      return send(res, 200, fs.readFileSync(abs), { 'Content-Type': MIME[path.extname(file)] });
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(UI_DIR, name);
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
    const headers = { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' };
    // Hand the browser the token on the way in, so app.css/app.js authenticate
    // themselves. Session cookie, no Secure (plain http on loopback).
    if (name === 'index.html') {
      headers['Set-Cookie'] = `${COOKIE_NAME}=${TOKEN}; Path=/; SameSite=Strict; HttpOnly`;
    }
    return send(res, 200, fs.readFileSync(file), headers);
  }

  if (token !== TOKEN) return send(res, 403, { error: 'Invalid or missing token' });

  // Progress stream
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(keepAlive); clients.delete(res); });
    return;
  }

  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return send(res, 404, { error: `No route for ${key}` });

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const out = await handler(body, url) ?? {};
    if (out.__raw) return send(res, 200, out.__raw, { 'Content-Type': out.__type, 'Cache-Control': 'max-age=60' });
    send(res, 200, out);
  } catch (err) {
    send(res, err.status ?? 500, { error: err.message });
  }
});

const PORT = Number(process.env.SCEVO_PORT) || 0;
server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address();
  COOKIE_NAME = `scevo_${port}`;
  const url = `http://127.0.0.1:${port}/?t=${TOKEN}`;
  console.log('');
  console.log('  SCEvo Deploy Tool');
  console.log(`  ${url}`);
  console.log('');
  console.log('  Repo:  ' + cfg.REPO_ROOT);
  console.log('  Ctrl+C to stop.');
  console.log('');
  if (!process.argv.includes('--no-open')) {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});

process.on('SIGINT', () => { hashcache.flush(); process.exit(0); });

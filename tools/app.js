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
        showVersionDebug: c.showVersionDebug === true,
      },
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
    for (const key of ['sc2InstallPath', 'launcherRepoPath', 'siteRepoPath']) {
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
    return { rows: out, missingRoots, melee: doc.melee, roots: doc.roots, ignoredCount: doc.ignore.length };
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

  // body: { source, patch?: { package, channel, name, description }, ignore?: true|false }
  'POST /api/catalog': async (body) => {
    const doc = catalog.load();
    if (!doc) throw new Error('No catalog yet');
    if (!body.source) throw new Error('Missing source');
    if (body.ignore === true) catalog.ignore(doc, body.source);
    else if (body.ignore === false) catalog.unignore(doc, body.source);
    else catalog.upsert(doc, body.source, body.patch || {});
    catalog.save(doc);
    return { item: catalog.findItem(doc, body.source) };
  },

  // body: { packages, only?, force? }  Builds, then regenerates the manifests.
  'POST /api/build': async (body) => runJob('build', async ({ log, progress }) => {
    const doc = catalog.load();
    const sc2Root = cfg.readConfig().sc2InstallPath;
    const packages = (body.packages || catalog.PACKAGES).filter((p) => catalog.PACKAGES.includes(p));
    const { results, pruned } = await builder.build({ doc, sc2Root, packages, only: body.only || null, force: !!body.force, log, progress });
    const gen = await generate({ doc, sc2Root, packages });
    gen.written.filter((w) => w.changed).forEach((w) => log(`Regenerated ${w.file}`));
    gen.problems.forEach((p) => log(`PROBLEM: ${p}`));
    return { results, pruned, manifests: gen.written, problems: gen.problems };
  }),

  /* ── manifests (generated; only the settings are edited) ───── */

  'GET /api/manifest': async (_b, url) => {
    const branch = ['beta', 'melee'].includes(url.searchParams.get('branch')) ? url.searchParams.get('branch') : 'public';
    const doc = catalog.load();
    if (!doc) return { needsInit: true };
    const file = { public: cfg.PUBLIC_MANIFEST, beta: cfg.BETA_MANIFEST, melee: cfg.MELEE_MANIFEST }[branch];
    const existing = mf.readManifest(file);
    const gen = await generate({ doc, sc2Root: cfg.readConfig().sc2InstallPath, packages: [branch === 'melee' ? 'melee' : 'campaign'], dryRun: true });
    const next = gen.docs[branch];
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
        coreVersion: existing?.versions?.multiplayer ?? '',
      } : null,
      meleeVersion: doc.melee.version,
      entries,
      problems: gen.problems,
    };
  },

  // Writes the manifest for a branch with the edited settings.
  'POST /api/manifest': async (body) => {
    const branch = ['beta', 'melee'].includes(body.branch) ? body.branch : 'public';
    const doc = catalog.load();
    const overrides = {};
    if (branch === 'public') overrides.public = { versions: body.versions, criticalUpdate: body.criticalUpdate };
    if (branch === 'beta') overrides.beta = { meta: body.betaMeta, criticalUpdate: body.criticalUpdate };
    if (branch === 'melee') {
      doc.melee.version = String(body.meleeVersion || doc.melee.version).trim();
      catalog.save(doc);
      overrides.melee = { version: doc.melee.version };
    }
    const gen = await generate({ doc, sc2Root: cfg.readConfig().sc2InstallPath, packages: [branch === 'melee' ? 'melee' : 'campaign'], overrides });
    return { written: gen.written, problems: gen.problems };
  },

  'POST /api/beta-code-hash': async (body) => ({ codeHash: mf.betaCodeHash(body.code ?? '') }),

  'POST /api/verify': async (body) => runJob('verify', async ({ progress, step }) => {
    const branch = ['beta', 'melee'].includes(body.branch) ? body.branch : 'public';
    step('checks', 'active', `${branch} manifest`);
    const r = branch === 'melee' ? await verify.preflightMelee(progress) : await verify.preflight(branch, progress);
    step('checks', r.canDeploy ? 'done' : 'failed', `${r.errors} error(s), ${r.warnings} warning(s)`);
    return r;
  }),

  // body: { packages: ['campaign','melee'], dryRun, force }
  'POST /api/deploy': async (body) => runJob('deploy', async ({ log, progress, step }) => {
    const packages = (body.packages || []).filter((p) => catalog.PACKAGES.includes(p));
    return deploy({ packages, dryRun: !!body.dryRun, force: !!body.force, updateSite: !!body.updateSite, log, progress, step });
  }),

  'GET /api/remote-orphans': async (_b, url) => {
    const branch = ['beta', 'melee'].includes(url.searchParams.get('branch')) ? url.searchParams.get('branch') : 'public';
    const prefix = { public: 'payload', beta: 'betapayload', melee: 'meleepayload' }[branch];
    const remote = await r2.listRemote(prefix);
    if (!remote.ok) return { ok: false, error: remote.error, orphans: [] };
    const known = new Set();
    if (branch === 'melee') {
      for (const f of verify.meleeFiles(mf.readManifest(cfg.MELEE_MANIFEST))) known.add(String(f.path).toLowerCase());
    } else {
      const doc = mf.readManifest(branch === 'beta' ? cfg.BETA_MANIFEST : cfg.PUBLIC_MANIFEST);
      for (const m of (doc?.modules ?? [])) for (const f of (m.files ?? [])) known.add(f.path.toLowerCase());
    }
    const orphans = remote.items.filter((o) => !known.has(o.path.replace(/\\/g, '/').toLowerCase()));
    return { ok: true, prefix, total: remote.items.length, orphans };
  },

  'POST /api/remote-delete': async (body) => runJob('remote-delete', async ({ log }) => {
    const prefix = ['payload', 'betapayload', 'meleepayload'].includes(body.prefix) ? body.prefix : null;
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

  'POST /api/cache-prune': async () => ({ removed: hashcache.prune(), cache: hashcache.stats() }),
};

/* ── HTTP plumbing ───────────────────────────────────────────────────────── */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

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

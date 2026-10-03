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
const scan = require('./lib/scan');
const mpq = require('./lib/mpq');
const verify = require('./lib/verify');
const r2 = require('./lib/r2');

const UI_DIR = path.join(__dirname, 'ui');
const TOKEN = crypto.randomBytes(16).toString('hex');

// Named per-port because cookies ignore the port component — two instances on
// different ports would otherwise clobber each other's token. Assigned once the
// server is listening; no request can arrive before that.
let COOKIE_NAME = 'scevo';

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
        showVersionDebug: c.showVersionDebug === true,
      },
      paths: {
        repoRoot: cfg.REPO_ROOT,
        sc2Valid: !!(c.sc2InstallPath && fs.existsSync(c.sc2InstallPath)),
        launcherValid: !!(c.launcherRepoPath && fs.existsSync(path.join(c.launcherRepoPath, 'package.json'))),
        payloadExists: fs.existsSync(cfg.PAYLOAD_DIR),
        betaExists: fs.existsSync(cfg.BETA_DIR),
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
    for (const key of ['sc2InstallPath', 'launcherRepoPath']) {
      if (typeof body[key] === 'string') patch[key] = body[key].trim();
    }
    if (typeof body.showVersionDebug === 'boolean') patch.showVersionDebug = body.showVersionDebug;
    return { config: cfg.updateConfig(patch) };
  },

  'GET /api/sources': async (_b, url) => {
    const c = cfg.readConfig();
    const root = url.searchParams.get('sc2Path') || c.sc2InstallPath;
    if (!root || !fs.existsSync(root)) return { sources: [], missingRoots: [], error: 'SC2 install path is not set or does not exist' };
    return scan.discoverSources(root);
  },

  // Veto works on every file, and un-veto is a first-class action.
  'POST /api/veto': async (body) => ({ veto: scan.setVeto(body.relPath, !!body.vetoed) }),

  'POST /api/package': async (body) => runJob('package', async ({ log, progress }) => {
    const c = cfg.readConfig();
    const { sources } = scan.discoverSources(c.sc2InstallPath);
    const byRel = new Map(sources.map((s) => [s.relPath.toLowerCase(), s]));
    const items = [];
    for (const it of (body.items ?? [])) {
      const src = byRel.get(String(it.relPath).toLowerCase());
      if (!src) { log(`Skipping unknown source: ${it.relPath}`); continue; }
      const targets = (it.targets ?? []).filter((t) => t === 'payload' || t === 'betapayload');
      if (targets.length) items.push({ src, targets });
    }
    if (!items.length) throw new Error('Nothing selected to package');
    log(`Packaging ${items.length} archive(s)…`);
    const results = await mpq.buildAll(items, progress);
    const failed = results.filter((r) => !r.ok);
    log(failed.length ? `${failed.length} of ${results.length} failed` : `All ${results.length} packaged`);
    return { results };
  }),

  'GET /api/manifest': async (_b, url) => {
    const branch = url.searchParams.get('branch') === 'beta' ? 'beta' : 'public';
    const file = branch === 'beta' ? cfg.BETA_MANIFEST : cfg.PUBLIC_MANIFEST;
    const existing = mf.readManifest(file);
    const scanned = await scan.scanPayload(branch);
    const modules = mf.buildWorkingSet({ existing, scanned });
    return {
      branch,
      exists: !!existing,
      versions: existing?.versions ?? { multiplayer: '', campaign: '' },
      // Carried forward verbatim so a save can never silently disable it.
      criticalUpdate: mf.mergeCritical(existing?.criticalUpdate, branch === 'beta'),
      betaMeta: branch === 'beta' ? {
        betaEnabled: !!existing?.betaEnabled,
        betaName: existing?.betaName ?? '',
        majorVersion: existing?.majorVersion ?? '',
        fullVersion: existing?.fullVersion ?? '',
        codeHash: existing?.codeHash ?? '',
        accentColor: existing?.theme?.accentColor ?? '#ff6600',
        coreVersion: existing?.versions?.multiplayer ?? '',
      } : null,
      modules,
      lastUpdated: existing?.lastUpdated ?? null,
    };
  },

  'POST /api/manifest': async (body) => {
    const branch = body.branch === 'beta' ? 'beta' : 'public';
    const file = branch === 'beta' ? cfg.BETA_MANIFEST : cfg.PUBLIC_MANIFEST;
    const modules = (body.modules ?? []).filter((m) => !body.dropMissing || m.state !== 'missing');
    const doc = branch === 'beta'
      ? mf.buildBetaManifest({
          meta: body.betaMeta ?? {},
          criticalUpdate: body.criticalUpdate,
          modules,
          coreVersion: body.betaMeta?.coreVersion,
        })
      : mf.buildPublicManifest({
          versions: body.versions,
          criticalUpdate: body.criticalUpdate,
          modules,
        });
    mf.writeManifest(file, doc);
    return { written: path.relative(cfg.REPO_ROOT, file), modules: doc.modules?.length ?? 0 };
  },

  'POST /api/beta-code-hash': async (body) => ({ codeHash: mf.betaCodeHash(body.code ?? '') }),

  // Moves both halves — the built file on disk and the manifest entry.
  'POST /api/promote': async (body) => runJob('promote', async ({ log }) => {
    const direction = body.direction === 'toBeta' ? 'toBeta' : 'toPublic';
    const moved = [];
    for (const p of (body.paths ?? [])) {
      const r = scan.promoteFile(p, direction);
      log(`${direction === 'toPublic' ? 'Promoted' : 'Copied to beta'}: ${p}`);
      moved.push({ path: p, ...r });
    }
    return { moved, direction };
  }),

  'POST /api/verify': async (body) => runJob('verify', async ({ progress, step }) => {
    const branch = body.branch === 'beta' ? 'beta' : 'public';
    step('checks', 'active', `${branch} manifest`);
    const r = await verify.preflight(branch, progress);
    step('checks', r.canDeploy ? 'done' : 'failed', `${r.errors} error(s), ${r.warnings} warning(s)`);
    return r;
  }),

  'POST /api/deploy': async (body) => runJob('deploy', async ({ log, progress, step }) => {
    const dryRun = !!body.dryRun;
    const branch = body.branch === 'beta' ? 'beta' : 'public';

    const rc = await r2.rcloneAvailable();
    if (!rc.ok) throw new Error(rc.error);

    // 0. Prove the credentials work before doing anything expensive. `rclone
    //    version` and `listremotes` both pass with a revoked key, so without
    //    this the first sign of trouble is a failed upload mid-transfer.
    log('Checking Cloudflare credentials…');
    const probe = await r2.rcloneProbe();
    if (!probe.ok) throw new Error(`R2 check failed (${probe.status}): ${probe.error}`);
    log(`R2 reachable — ${probe.prefixes.length} top-level object(s)/prefix(es) in ${probe.bucket}`);

    // 1. Preflight — never upload against a manifest that disagrees with disk.
    step('preflight', 'active');
    log('Running preflight checks…');
    const pre = await verify.preflight(branch, progress);
    if (!pre.canDeploy && !body.force) {
      step('preflight', 'failed', `${pre.errors} error(s)`);
      return { stage: 'preflight', aborted: true, preflight: pre };
    }
    if (!pre.canDeploy) log(`Proceeding despite ${pre.errors} error(s) — force was requested`);
    step('preflight', 'done', pre.canDeploy
      ? `${pre.findings.length} checks, ${pre.warnings} warning(s)`
      : `forced past ${pre.errors} error(s)`);

    // 2. Stage launcher artifacts and regenerate launcher-version.json.
    step('stage', 'active');
    const staged = await r2.stageLauncherArtifacts();
    staged.staged.forEach((f) => log(`Staged ${f}`));
    staged.skipped.forEach((f) => log(`${f} unchanged, not re-copied`));
    staged.warnings.forEach((w) => log(`WARNING: ${w}`));
    const lv = r2.writeLauncherVersion();
    log(lv.ok ? `launcher-version.json -> v${lv.version}` : `WARNING: ${lv.error}`);
    step('stage', 'done', lv.ok
      ? `launcher v${lv.version}, ${staged.staged.length} copied, ${staged.skipped.length} unchanged`
      : 'launcher repo not configured — existing artifacts left as they are');

    // 3. Payload and binaries FIRST. Manifests must never be live ahead of
    //    the bytes they describe.
    step('payload', 'active');
    const uploads = [];
    for (const folder of cfg.UPLOAD_FOLDERS) {
      log(`Uploading ${folder.name}…`);
      const r = await r2.uploadFolder(folder.local, { dryRun, onProgress: progress, onLog: log });
      uploads.push(r);
      if (!r.ok) {
        step('payload', 'failed', `${folder.name}: ${r.error}`);
        throw new Error(`${folder.name} upload failed: ${r.error}`);
      }
    }
    const sent = uploads.reduce((n, u) => n + (u.transfers ?? 0), 0);
    const bytes = uploads.reduce((n, u) => n + (u.bytes ?? 0), 0);
    step('payload', 'done', `${sent} file(s), ${(bytes / 1048576).toFixed(1)} MB`);

    // 4. Confirm the CDN actually has everything at the right size.
    let post = null;
    if (dryRun) {
      step('postflight', 'skipped', 'dry run — nothing to verify');
    } else {
      step('postflight', 'active');
      log('Verifying uploaded files on the CDN…');
      const manifestDoc = mf.readManifest(branch === 'beta' ? cfg.BETA_MANIFEST : cfg.PUBLIC_MANIFEST);
      post = await verify.postflight(manifestDoc, branch, progress);
      const bad = post.filter((f) => f.level === 'error');
      if (bad.length && !body.force) {
        step('postflight', 'failed', `${bad.length} file(s) wrong or missing on the CDN`);
        return { stage: 'postflight', aborted: true, preflight: pre, uploads, postflight: post };
      }
      step('postflight', 'done', bad.length ? `forced past ${bad.length} error(s)` : 'all files present at the right size');
    }

    // 5. Only now publish the manifests.
    step('manifests', 'active');
    log('Uploading manifests (last)…');
    const manifestUpload = await r2.uploadFolder(cfg.MANIFEST_FOLDER.local, { dryRun, onProgress: progress, onLog: log });
    uploads.push(manifestUpload);
    if (!manifestUpload.ok) {
      step('manifests', 'failed', manifestUpload.error);
      throw new Error(`Manifest upload failed: ${manifestUpload.error}`);
    }
    step('manifests', 'done', `${manifestUpload.transfers ?? 0} file(s)`);

    // 6. Read back what we just published.
    let published = null;
    if (dryRun) {
      step('confirm', 'skipped', 'dry run — nothing was published');
    } else {
      step('confirm', 'active');
      log('Confirming published manifests…');
      published = await verify.verifyPublishedManifests();
      const bad = published.filter((f) => f.level === 'error');
      step('confirm', bad.length ? 'failed' : 'done',
        bad.length ? `${bad.length} manifest(s) did not read back` : 'published manifests match');
    }
    log(dryRun ? 'Dry run complete.' : 'Deploy complete.');
    return { stage: 'complete', dryRun, preflight: pre, uploads, postflight: post, published, launcherVersion: lv };
  }),

  'GET /api/remote-orphans': async (_b, url) => {
    const branch = url.searchParams.get('branch') === 'beta' ? 'beta' : 'public';
    const prefix = branch === 'beta' ? 'betapayload' : 'payload';
    const remote = await r2.listRemote(prefix);
    if (!remote.ok) return { ok: false, error: remote.error, orphans: [] };
    const doc = mf.readManifest(branch === 'beta' ? cfg.BETA_MANIFEST : cfg.PUBLIC_MANIFEST);
    const known = new Set((doc?.modules ?? []).flatMap((m) => (m.files ?? []).map((f) => f.path.toLowerCase())));
    const orphans = remote.items.filter((o) => !known.has(o.path.replace(/\\/g, '/').toLowerCase()));
    return { ok: true, prefix, total: remote.items.length, orphans };
  },

  'POST /api/remote-delete': async (body) => runJob('remote-delete', async ({ log }) => {
    const results = [];
    for (const p of (body.paths ?? [])) {
      const r = await r2.deleteRemote(body.prefix === 'betapayload' ? 'betapayload' : 'payload', p);
      log(r.ok ? `Deleted ${p}` : `FAILED ${p}: ${r.error}`);
      results.push(r);
    }
    return { results };
  }),

  'GET /api/news': async () => {
    const doc = mf.readManifest(cfg.NEWS_FEED);
    return { exists: !!doc, news: doc ?? null };
  },

  'POST /api/news': async (body) => {
    if (!body.news || typeof body.news !== 'object') throw new Error('Missing news payload');
    const doc = { ...body.news, lastUpdated: mf.nowIso() };
    mf.writeManifest(cfg.NEWS_FEED, doc);
    return { written: path.relative(cfg.REPO_ROOT, cfg.NEWS_FEED) };
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
    send(res, 200, await handler(body, url) ?? {});
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

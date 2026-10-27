'use strict';
// Pre-push checks, one front at a time. Read-only: nothing is built, written or uploaded.
//
//   run.cmd check <front> [--quick]
//     blog [<post-id>]  one post (or every listed post): files, frontmatter, images, short URL, sitemap, previews
//     site              the website repo: branch, uncommitted work, data files, broken /assets links, launcher info
//     launcher          the launcher repo: version vs the live one, build output, Windows 7 build, tests
//     assets            SCEvo_AssetUploads: Prepare-Upload.ps1 dry run (split asset mods in sync, nothing unresolved),
//                       then models and textures: nothing new that game data or a model names is missing
//     mods              the deploy catalog: new or missing sources, files that need a Build
//     cdn               R2 credentials, preflight of every manifest, the CDN address, what isn't deployed yet
//     all               every front above
//   --quick skips the slow parts (test suites, hashing the payload).
//   --all   (assets) lists every missing model / texture, not just those new since the release tags.
//
// Each check prints PASS, WARN or FAIL with what to do. Exits 1 when anything FAILs.
// Repo paths: siteRepoPath / launcherRepoPath / assetUploadsPath / devRepoPath / campaignRepoPath in
// deploy-config.json, else the folders next to this repo (..\EvoSite, ..\SCEvo_AssetUploads, ..\SCEvoDev,
// ..\SCBW_Campaign).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cfg = require('./lib/config');

const results = [];
const C = process.stdout.isTTY ? { PASS: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m', INFO: '\x1b[36m', end: '\x1b[0m' } : { end: '' };
function report(level, name, detail = '') {
  results.push({ level, name });
  console.log(`  ${C[level] || ''}${level.padEnd(4)}${C.end}  ${name}${detail ? `\n          ${String(detail).replace(/\n/g, '\n          ')}` : ''}`);
}
const pass = (n, d) => report('PASS', n, d), warn = (n, d) => report('WARN', n, d), fail = (n, d) => report('FAIL', n, d), info = (n, d) => report('INFO', n, d);
const section = (title) => console.log(`\n${title}\n${'─'.repeat(title.length)}`);
const list = (items, max = 8) => items.slice(0, max).join('\n') + (items.length > max ? `\n… and ${items.length - max} more` : '');

const conf = cfg.readConfig();
const sibling = (name) => path.join(cfg.REPO_ROOT, '..', name);
const SITE = conf.siteRepoPath || sibling('EvoSite');
const LAUNCHER = conf.launcherRepoPath || null;
const ASSET_UPLOADS = conf.assetUploadsPath || sibling('SCEvo_AssetUploads');
const DEV = conf.devRepoPath || sibling('SCEvoDev');
const CAMPAIGN = conf.campaignRepoPath || sibling('SCBW_Campaign');

function run(cmd, args, cwd, { shell = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? (r.error ? -1 : 0), out: `${r.stdout || ''}${r.stderr || ''}`, error: r.error };
}
const tail = (text, n = 12) => text.trim().split(/\r?\n/).slice(-n).join('\n');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

// Branch, uncommitted files and unpushed commits of one repo. Work happens on whatever branch is
// current; liveBranch only adds a reminder that it goes live once merged there (the site: Netlify).
function gitState(repo, label, { liveBranch = null } = {}) {
  const branch = run('git', ['-C', repo, 'branch', '--show-current']).out.trim();
  if (!branch) { warn(`${label}: not a git repo, or git is missing`); return; }
  if (liveBranch && branch !== liveBranch) info(`${label}: on branch "${branch}"`, `Goes live once merged into ${liveBranch}.`);
  else pass(`${label}: on ${branch}`);
  const dirty = run('git', ['-C', repo, 'status', '--porcelain']).out.split(/\r?\n/).filter(Boolean);
  if (dirty.length) warn(`${label}: ${dirty.length} uncommitted change(s)`, list(dirty.map((l) => l.trim())));
  else pass(`${label}: working tree clean`);
  const ahead = run('git', ['-C', repo, 'rev-list', '--count', '@{u}..HEAD']);
  if (ahead.code === 0 && +ahead.out.trim() > 0) info(`${label}: ${ahead.out.trim()} commit(s) not pushed yet`);
}

// ─── blog ───
// Frontmatter between the first two --- lines, as plain key: value strings.
function frontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}
// Site-root paths a page or post points at (/assets/…), without query strings.
// HTML comments are skipped (they hold usage examples, not live links).
const assetRefs = (text) => [...new Set([...text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/["'(=\s]\/(assets\/[^"')\s?#]+)/g)].map((m) => decodeURI(m[1])))];
const missingAssets = (text) => assetRefs(text).filter((rel) => !fs.existsSync(path.join(SITE, rel)));
const shortUrl = (url) => (url ? `/${url.replace(/_/g, '-')}` : null);

function checkPost(id, listed, { sitemap, redirects, single }) {
  const md = path.join(SITE, 'posts', `${id}.md`);
  const html = path.join(SITE, 'posts', `${id}.html`);
  const problems = [], notes = [];
  if (!fs.existsSync(md)) { fail(`${id}: posts/${id}.md is missing`); return; }
  const text = fs.readFileSync(md, 'utf8');
  const fm = frontmatter(text);
  if (!fm) { fail(`${id}: no frontmatter (--- block) at the top of the .md`); return; }
  for (const key of ['title', 'author', 'date', 'blog-image', 'tags']) if (!fm[key]) problems.push(`frontmatter has no ${key}`);
  if (fm.date && !/^\d{4}-\d{2}-\d{2}$/.test(fm.date)) problems.push(`date "${fm.date}" is not YYYY-MM-DD`);
  if (fm['blog-image'] && !fs.existsSync(path.join(SITE, fm['blog-image'].replace(/^\//, '')))) problems.push(`blog-image ${fm['blog-image']} does not exist`);
  const gone = missingAssets(text);
  if (gone.length) problems.push(`${gone.length} image/video path(s) in the post don't exist:\n  ${list(gone, 6).replace(/\n/g, '\n  ')}`);
  for (const f of fs.readdirSync(path.join(SITE, 'posts')).filter((f) => f.startsWith(`${id}.`) && /^[a-z]{2}[A-Z]{2}\.md$/.test(f.slice(id.length + 1)))) {
    const lost = missingAssets(fs.readFileSync(path.join(SITE, 'posts', f), 'utf8'));
    if (lost.length) problems.push(`${f}: ${lost.length} missing path(s): ${lost.slice(0, 3).join(', ')}`);
  }
  if (!fs.existsSync(html)) problems.push(`posts/${id}.html is missing (node scripts/build-postlist.mjs add ${id} creates it)`);
  else {
    const page = fs.readFileSync(html, 'utf8');
    if (!page.includes(`data-post-id="${id}"`)) problems.push(`posts/${id}.html has no data-post-id="${id}"`);
    // The link preview Discord/X show: the post's own image (build-og-images.mjs) or the generic one.
    const og = /property="og:image"\s+content="https:\/\/scevo\.org\/([^"]+)"/.exec(page)?.[1];
    if (!og) notes.push('no og:image in the page head (node scripts/normalize-head.mjs)');
    else if (!fs.existsSync(path.join(SITE, og))) problems.push(`og:image /${og} does not exist (node scripts/build-og-images.mjs)`);
    else if (single && !og.includes(id)) notes.push('link previews use the generic image (a hero background + node scripts/build-og-images.mjs gives it its own)');
  }

  if (!listed) {
    (single ? warn : info)(`${id}: not released (not in postList.json)`, `When it's ready: node scripts/build-postlist.mjs add ${id}`);
  } else {
    if (listed.title !== fm.title || listed.date !== fm.date || listed['blog-image'] !== fm['blog-image']) {
      problems.push('postList.json is out of date with the .md (run: node scripts/build-postlist.mjs)');
    }
    const url = shortUrl(fm.url);
    if (url && !new RegExp(`^${url.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s+/posts/${id}\\.html\\s+200`, 'm').test(redirects)) {
      problems.push(`_redirects has no rule for ${url} (run: node scripts/build-postlist.mjs)`);
    }
    if (!sitemap.includes(`/posts/${id}<`) && !sitemap.includes(`/posts/${id}.html<`) && !(url && sitemap.includes(`${url}<`))) problems.push('not in sitemap.xml (run: node scripts/build-sitemap.mjs)');
  }
  if (problems.length) fail(`${id}`, list(problems, 10));
  else if (notes.length) warn(`${id}`, notes.join('\n'));
  else if (single) pass(`${id}${listed ? '' : ' (files ok)'}`);
  return !problems.length && !notes.length;
}

function checkBlog(postId) {
  section(postId ? `Blog post: ${postId}` : 'Blog posts');
  if (!fs.existsSync(path.join(SITE, 'posts'))) { fail(`Website repo not found at ${SITE}`, 'Set "siteRepoPath" in deploy-config.json.'); return; }
  let postList;
  try { postList = readJson(path.join(SITE, 'assets', 'data', 'postList.json')); } catch (e) { fail('assets/data/postList.json does not parse', e.message); return; }
  const byId = new Map(postList.map((p) => [path.basename(p.link || '', '.html'), p]));
  const read = (rel) => { try { return fs.readFileSync(path.join(SITE, rel), 'utf8'); } catch { return ''; } };
  const ctx = { sitemap: read('sitemap.xml'), redirects: read('_redirects') };
  if (postId) { checkPost(postId.replace(/\.(md|html)$/, ''), byId.get(postId.replace(/\.(md|html)$/, '')), { ...ctx, single: true }); return; }
  const clean = [...byId.keys()].filter((id) => checkPost(id, byId.get(id), ctx)).length;
  if (clean) pass(`${clean} of ${byId.size} released post(s) clean`);
  const unlisted = fs.readdirSync(path.join(SITE, 'posts')).filter((f) => /^[^.]+\.md$/.test(f)).map((f) => f.slice(0, -3)).filter((id) => !byId.has(id));
  if (unlisted.length) info(`${unlisted.length} post(s) on disk but not released`, list(unlisted));
}

// ─── site ───
function checkSite() {
  section(`Website (${SITE})`);
  if (!fs.existsSync(path.join(SITE, 'index.html'))) { fail(`Website repo not found at ${SITE}`, 'Set "siteRepoPath" in deploy-config.json.'); return; }
  gitState(SITE, 'site', { liveBranch: 'main' });

  const dataDir = path.join(SITE, 'assets', 'data');
  const badJson = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json')).filter((f) => { try { readJson(path.join(dataDir, f)); return false; } catch { return true; } });
  if (badJson.length) fail(`${badJson.length} data file(s) don't parse`, list(badJson)); else pass('assets/data/*.json all parse');

  const pages = [
    ...fs.readdirSync(SITE).filter((f) => f.endsWith('.html')),
    ...['posts', 'ladder'].flatMap((d) => (fs.existsSync(path.join(SITE, d)) ? fs.readdirSync(path.join(SITE, d)).filter((f) => f.endsWith('.html')).map((f) => `${d}/${f}`) : [])),
  ];
  const broken = pages.flatMap((p) => missingAssets(fs.readFileSync(path.join(SITE, p), 'utf8')).map((rel) => `${p} → /${rel}`));
  if (broken.length) fail(`${broken.length} broken /assets link(s) in ${pages.length} pages`, list(broken)); else pass(`no broken /assets links in ${pages.length} pages`);

  // The download page's launcher info against what the deploy tool last published.
  try {
    const site = readJson(path.join(dataDir, 'launcher-version.json'));
    const deployed = fs.existsSync(cfg.LAUNCHER_VER) ? readJson(cfg.LAUNCHER_VER) : null;
    if (!deployed) info('no manifests/launcher-version.json here to compare the download page with');
    else if (site.version !== deployed.version) warn(`download page shows launcher ${site.version}, deployed is ${deployed.version}`, 'Run: node scripts/sync-launcher-info.mjs (or deploy the launcher with --update-site)');
    else pass(`download page launcher info matches ${deployed.version}`);
    const links = fs.readFileSync(path.join(SITE, 'assets', 'js', 'site-links.js'), 'utf8');
    if (deployed && !links.includes(`v=${deployed.version}`)) warn('site-links.js download links are not on the deployed launcher version', 'Deploy the launcher with "Update website download links" ticked, or edit assets/js/site-links.js.');
  } catch (e) { warn('could not compare the launcher info', e.message); }

  checkBlog();
}

// ─── launcher ───
async function checkLauncher(quick) {
  section(`Launcher (${LAUNCHER || 'launcherRepoPath not set'})`);
  if (!LAUNCHER || !fs.existsSync(path.join(LAUNCHER, 'package.json'))) { fail('launcher repo not found', 'Set "launcherRepoPath" in deploy-config.json (Settings tab).'); return; }
  gitState(LAUNCHER, 'launcher');
  const r2 = require('./lib/r2');
  const version = readJson(path.join(LAUNCHER, 'package.json')).version;
  const live = await r2.publishedLauncherVersion();
  const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
  if (!live) warn('could not read the live launcher-version.json', `package.json is ${version}`);
  else if (cmp(version, live.version) < 0) fail(`package.json ${version} is older than the live ${live.version}`);
  else if (cmp(version, live.version) === 0) info(`package.json ${version} = live (${live.source}): nothing new to publish`, 'Bump "version" in package.json before building a release.');
  else pass(`package.json ${version} > live ${live.version}`);

  const built = r2.builtVersion(LAUNCHER, 'dist-electron');
  const exes = [r2.PORTABLE_EXE, r2.SETUP_EXE].filter((f) => !fs.existsSync(path.join(LAUNCHER, 'dist-electron', f)));
  if (built !== version || exes.length) fail(`dist-electron is ${built ? `built at ${built}` : 'not built'}${exes.length ? `, missing ${exes.join(', ')}` : ''}`, 'Run: npm run build');
  else pass(`dist-electron built at ${version}`);
  // A build:devtest build carries the debug toolbar (and with it the match analysis): never publish one.
  const asarFile = path.join(LAUNCHER, 'dist-electron', 'win-unpacked', 'resources', 'app.asar');
  try {
    const asar = require('node:module').createRequire(path.join(LAUNCHER, 'package.json'))('@electron/asar');
    const pkg = JSON.parse(asar.extractFile(asarFile, 'package.json'));
    const ui = asar.listPackage(asarFile).filter((f) => /dist[\\/]assets[\\/]index-[^\\/]+\.js$/.test(f));
    const debugUi = ui.some((f) => asar.extractFile(asarFile, f.replace(/^[\\/]/, '')).toString().includes('Debug Mode'));
    if (pkg.devtools === true || debugUi) fail('dist-electron is a devtest build (debug toolbar, DevTools)', 'Rebuild with: npm run build');
    else pass('release build (no debug toolbar)');
  } catch (e) { warn('could not inspect app.asar for a devtest build', e.message); }
  if (fs.existsSync(path.join(LAUNCHER, 'dist-electron-win7'))) {
    if (r2.win7Fresh(LAUNCHER)) pass(`Windows 7 build at ${version}`);
    else warn('Windows 7 build is not at this version: it will not be published', 'Run: npm run build:win7 (or ignore to keep the live Windows 7 version).');
  }
  const pending = await require('./lib/pending').launcherPending({ r2 }).catch((e) => ({ details: [e.message] }));
  if (pending.warn) warn(pending.details.join('; '));

  if (quick) { info('tests skipped (--quick)'); return; }
  const t = run('npm test', [], LAUNCHER, { shell: true });
  const summary = (t.out.match(/ℹ (tests|pass|fail) \d+/g) || []).join(', ');
  if (t.code === 0) pass(`npm test${summary ? ` (${summary})` : ''}`); else fail('npm test failed', tail(t.out));
}

// ─── assets ───
function checkAssets(all) {
  checkSplitMods();
  checkModelFiles(all);
}

function checkSplitMods() {
  section(`Split asset mods (${ASSET_UPLOADS})`);
  const script = path.join(ASSET_UPLOADS, 'Prepare-Upload.ps1');
  if (!fs.existsSync(script)) { fail('Prepare-Upload.ps1 not found', 'Set "assetUploadsPath" in deploy-config.json.'); return; }
  gitState(ASSET_UPLOADS, 'asset uploads');
  const r = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], ASSET_UPLOADS);
  const counts = /new: (\d+)\s+changed: (\d+)\s+stale: (\d+)\s+duplicates: (\d+)\s+unresolved: (\d+)/.exec(r.out);
  if (!counts) { fail('Prepare-Upload.ps1 did not finish', tail(r.out)); return; }
  const [, n, c, s, d, u] = counts.map(Number);
  if (u) fail(`${u} new asset file(s) with no split mod`, 'Add them to "routes" in asset-routing.json (the report prints the snippet), then re-run.');
  if (d) warn(`${d} file(s) in more than one split mod`, 'Pick the owner in asset-routing.json, then Prepare-Upload.ps1 -Apply.');
  if (n + c + s) warn(`split mods out of date: ${n} new, ${c} changed, ${s} to delete`, 'Run: Prepare-Upload.ps1 -Apply, then this check again.');
  if (!u && !d && !(n + c + s)) pass('split asset mods match dev SCEvo_Assets');
  const mods = [...r.out.matchAll(/^- (\S+\.SC2(?:Mod|Map))/gm)].map((m) => m[1]);
  const split = [...r.out.matchAll(/^### (\S+\.SC2Mod)\s+\(needs upload\)/gm)].map((m) => m[1]);
  if (mods.length || split.length) info('to upload to Battle.net after this', list([...new Set([...mods, ...split])], 20));
  if (/uncommitted change\(s\) in the dev repo/.test(r.out)) warn('the dev repo (SCEvoDev) has uncommitted changes', 'Commit them before tagging the release.');
}

// Every model game data asks for, and every texture a model or game data names, must exist in
// vanilla SC2 (CascView extraction), an Evo mod (SCEvo_Assets, SCEvo_CampaignAssets, …) or the map itself.
function checkModelFiles(all) {
  const decals = require('./lib/decals');
  const { modelCheck } = require('./lib/modelcheck');
  const src = decals.sourcePaths(conf);
  const cascRoot = /^(.*?)[\\/]mods[\\/]liberty\.sc2mod/i.exec(src.assets)?.[1] || null;
  const r = modelCheck({ devRoot: DEV, campaignRoot: CAMPAIGN, cascRoot, gameDataPath: conf.sc2GameDataPath || decals.DEFAULT_PATHS.sc2GameDataPath, all });
  const since = [r.since.dev, r.since.campaign].filter(Boolean).join(' / ');
  section(`Models and textures (${all ? 'everything' : `new since ${since || 'no release tag: everything'}`})`);
  r.warnings.forEach((w) => warn(w, 'Set the decal texture folder (Settings) to the CascView extraction, e.g. D:\\Casc Viewer\\SC2\\mods\\liberty.sc2mod\\base.sc2assets\\assets\\textures.'));

  const short = (p) => p.replace(/^Base\.SC2(Assets|Data\/GameData)\//i, '');
  // One line per missing file: where it's used first, and how many other places use it.
  const lines = (ps) => {
    const groups = new Map();
    for (const p of ps) {
      const key = p.ref.replace(/\\/g, '/').toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    return [...groups.values()].map((g) => `${g[0].ref}${g[0].deleted ? '  (deleted since the release)' : ''}\n  ← ${g[0].container}: ${short(g[0].from)}${g.length > 1 ? ` and ${g.length - 1} more` : ''}`);
  };
  const max = all ? 500 : 10;
  const fresh = r.problems.filter((p) => p.isNew || all);
  const absolute = fresh.filter((p) => p.absolute);
  const errors = fresh.filter((p) => p.level === 'error' && !p.absolute);
  const byName = fresh.filter((p) => p.level === 'warn' && p.byName);
  const unknown = fresh.filter((p) => p.level === 'warn' && !p.byName);
  if (absolute.length) {
    // One line per model: the fix is one re-export.
    const models = new Map();
    for (const p of absolute) {
      const key = `${p.container}: ${short(p.from)}`;
      if (!models.has(key)) models.set(key, []);
      models.get(key).push(p.ref);
    }
    const rows = [...models].map(([m, refs]) => `${m}\n  ${refs[0]}${refs.length > 1 ? ` and ${refs.length - 1} more` : ''}`);
    fail(`${models.size} model(s) with drive-letter texture paths`, `${list(rows, max)}\nRe-export with MoPaQ paths, so they read Assets\\Textures\\File.dds.`);
  }
  if (errors.length) fail(`${lines(errors).length} missing model / texture file(s)`, `${list(lines(errors), max)}\nAdd the file to SCEvo_Assets (or SCEvo_CampaignAssets / the map), or point the model or game data elsewhere.`);
  if (byName.length) warn(`${lines(byName).length} texture path(s) that don't exist, though a texture of that name does`, `${list(lines(byName), max)}\nFix the path in the model (re-export) or the game data.`);
  if (unknown.length) warn(`${lines(unknown).length} game data texture(s) not in Evo or the extracted vanilla files`, `${list(lines(unknown), max)}\nIf it's vanilla campaign / coop art, extract that part of SC2 with CascView under ${cascRoot || 'the CascView SC2 folder'}; otherwise add the file.`);
  if (!absolute.length && !errors.length && !byName.length && !unknown.length) pass(`no missing models or textures${all ? '' : ' in new work'} (${r.stats.references} references in ${r.stats.containers} mods and maps)`);
  const older = r.problems.filter((p) => !p.isNew && !all);
  if (older.length) info(`${older.length} older missing reference(s), from before ${since}`, 'run.cmd check assets --all lists them.');
}

// ─── mods ───
function checkMods() {
  section('Mod packaging (deploy catalog)');
  const catalog = require('./lib/catalog');
  const { statusOf } = require('./lib/build');
  const doc = catalog.load();
  if (!doc) { fail('no deploy-catalog.json', 'Run: run.cmd init'); return; }
  if (!conf.sc2InstallPath || !fs.existsSync(conf.sc2InstallPath)) { fail('sc2InstallPath is not set or missing', 'Settings tab, or deploy-config.json.'); return; }
  if (fs.existsSync(cfg.MPQ_EDITOR)) pass('MPQEditor.exe present'); else fail('MPQEditor.exe missing from the repo root', 'Folder sources cannot be packaged without it.');
  const { rows, missingRoots } = catalog.classify(doc, conf.sc2InstallPath);
  if (missingRoots.length) fail('scan root(s) not found in the SC2 install', list(missingRoots)); else pass(`${doc.roots.length} scan roots found`);
  const fresh = rows.filter((r) => r.status === 'new').map((r) => r.source);
  if (fresh.length) warn(`${fresh.length} new source(s) not decided`, `${list(fresh)}\nDecide on the Catalog tab, or run.cmd set / ignore.`);
  const missing = rows.filter((r) => r.status === 'missing' && r.item && r.item.channel !== 'off').map((r) => r.source);
  if (missing.length) fail(`${missing.length} shipped source(s) missing from the SC2 install`, list(missing));
  const st = statusOf(doc, rows);
  const stale = rows.filter((r) => r.item && r.item.channel !== 'off' && r.status !== 'missing')
    .map((r) => [r, st.get(catalog.keyOf(r.source))]).filter(([, s]) => s && s !== 'built');
  if (stale.length) warn(`${stale.length} source(s) changed since the last Build`, `${list(stale.map(([r, s]) => `${r.item.package.padEnd(9)} ${s.padEnd(8)} ${r.source}`))}\nRun: run.cmd build --package <campaign|melee> (or tick them on the Catalog tab).`);
  else pass('every shipped source is built');
  const tagged = rows.filter((r) => r.item?.meleeBeta).length;
  if (tagged) info(`${tagged} mod(s) tagged for the melee beta`, 'Rebuild it with run.cmd build --package meleebeta after changing them.');
}

// ─── cdn ───
async function checkCdn(quick) {
  section('Cloudflare R2 / CDN');
  const r2 = require('./lib/r2');
  const verify = require('./lib/verify');
  const rc = await r2.rcloneAvailable();
  if (!rc.ok) { fail('rclone', rc.error); return; }
  const probe = await r2.rcloneProbe();
  if (probe.ok) pass(`R2 reachable: ${probe.bucket}`); else fail(`R2 credentials (${probe.status})`, probe.error);

  if (cfg.publicBase() !== cfg.publicBases().at(-1)) {
    const c = await require('./lib/cdncheck').cdnCheck(cfg.publicBase());
    if (c.ready) pass(`CDN address ${c.base} ready`); else fail(`CDN address ${c.base} not ready`, list(c.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`)));
  } else info('no custom CDN address set: downloads use r2.dev');

  const show = (label, r) => {
    const errs = r.findings.filter((f) => f.level === 'error'), warns = r.findings.filter((f) => f.level === 'warn');
    if (errs.length) fail(`${label}: ${errs.length} error(s)`, list(errs.map((f) => `${f.code}: ${f.message}`)));
    else if (warns.length) warn(`${label}: ${warns.length} warning(s)`, list(warns.map((f) => `${f.code}: ${f.message}`)));
    else pass(`${label}: preflight clean`);
  };
  if (quick) {
    // Structure only: no hashing of the payload against the manifests.
    for (const [label, file, branch] of [['update-manifest.json', cfg.PUBLIC_MANIFEST, 'public'], ['beta-manifest.json', cfg.BETA_MANIFEST, 'beta']]) {
      const h = verify.checkJsonHygiene(file);
      show(`${label} (quick)`, verify.summarize([...h.findings, ...(h.parsed ? verify.checkStructure(h.parsed, branch) : [])]));
    }
  } else {
    show('update-manifest.json', await verify.preflight('public'));
    show('beta-manifest.json', await verify.preflight('beta'));
    show('melee-manifest.json', await verify.preflightMelee());
    show('melee-beta-manifest.json', await verify.preflightMeleeBeta());
  }

  const pend = await require('./lib/pending').pendingPackages();
  if (pend.offline) warn('could not reach the CDN to compare manifests');
  const changed = Object.entries(pend.packages).filter(([, p]) => p.changed);
  if (changed.length) info('not deployed yet', changed.map(([k, p]) => `${k}: ${p.details.join(', ')}`).join('\n'));
  else pass('local manifests match the live CDN');

  if (quick) { info('deploy tool tests skipped (--quick)'); return; }
  const tests = fs.readdirSync(path.join(cfg.TOOLS_DIR, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('tools', 'test', f));
  const t = run(process.execPath, ['--test', ...tests], cfg.REPO_ROOT);
  if (t.code === 0) pass('deploy tool tests'); else fail('deploy tool tests failed', tail(t.out));
  const s = run(process.execPath, ['tools/smoke.js'], cfg.REPO_ROOT);
  if (s.code === 0) pass('deploy tool smoke test'); else fail('deploy tool smoke test failed', tail(s.out));
}

const FRONTS = {
  blog: (a) => checkBlog(a._[1]),
  site: () => checkSite(),
  launcher: (a) => checkLauncher(a.quick),
  assets: (a) => checkAssets(a.all),
  mods: () => checkMods(),
  cdn: (a) => checkCdn(a.quick),
};

async function main(argv) {
  const args = { _: argv.filter((a) => !a.startsWith('--')), quick: argv.includes('--quick'), all: argv.includes('--all') };
  const front = args._[0];
  if (!front || !(front in FRONTS || front === 'all')) {
    console.log(`Usage: run.cmd check <${Object.keys(FRONTS).join('|')}|all> [--quick] [--all]   (blog takes an optional post id)`);
    process.exitCode = 2;
    return;
  }
  const order = front === 'all' ? ['assets', 'mods', 'cdn', 'launcher', 'site'] : [front];
  for (const f of order) {
    try { await FRONTS[f](args); } catch (e) { fail(`${f}: the check itself crashed`, e.stack || e.message); }
  }
  const n = (l) => results.filter((r) => r.level === l).length;
  console.log(`\n${n('FAIL') ? `${C.FAIL || ''}NOT READY${C.end}` : n('WARN') ? `${C.WARN || ''}READY WITH WARNINGS${C.end}` : `${C.PASS || ''}READY${C.end}`}: ${n('PASS')} pass, ${n('WARN')} warn, ${n('FAIL')} fail`);
  if (n('FAIL')) process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { frontmatter, assetRefs, shortUrl };

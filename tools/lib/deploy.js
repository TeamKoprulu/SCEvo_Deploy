'use strict';
// The deploy sequence, shared by the GUI (app.js) and the CLI (cli.js).
//
//   probe -> regenerate manifests -> preflight -> stage launcher (launcher)
//   -> upload payload folders -> postflight (CDN HEAD checks) -> upload manifests LAST -> read back
//
// `packages` picks what goes up: any of 'campaign' (mods, maps, news), 'melee' and
// 'launcher' (exe, installer, launcher-version.json). Each package uploads only its
// own folders and its own manifests.

const cfg = require('./config');
const catalog = require('./catalog');
const { generate } = require('./generate');
const verify = require('./verify');
const r2 = require('./r2');
const mf = require('./manifest');
const site = require('./site');

const DEPLOY_PACKAGES = ['campaign', 'melee', 'launcher'];
const MANIFESTS = {
  campaign: ['update-manifest.json', 'beta-manifest.json', 'news-feed.json'],
  melee: ['melee-manifest.json'],
  launcher: ['launcher-version.json'],
};

async function deploy({ packages, dryRun = false, force = false, updateSite = false, log = () => {}, progress = () => {}, step = () => {} }) {
  if (!packages || !packages.length) throw new Error('Choose at least one package to deploy');
  const doc = catalog.load();
  if (!doc) throw new Error('No deploy-catalog.json yet. Run: run.cmd init');
  const sc2Root = cfg.readConfig().sc2InstallPath;

  const rc = await r2.rcloneAvailable();
  if (!rc.ok) throw new Error(rc.error);
  log('Checking Cloudflare credentials…');
  const probe = await r2.rcloneProbe();
  if (!probe.ok) throw new Error(`R2 check failed (${probe.status}): ${probe.error}`);
  log(`R2 reachable — ${probe.bucket}`);

  // 1. Manifests always match the catalog and the built files (the launcher has none to generate).
  const built = packages.filter((p) => catalog.PACKAGES.includes(p));
  step('generate', 'active');
  const gen = built.length ? await generate({ doc, sc2Root, packages: built, dryRun: false }) : { written: [], problems: [] };
  gen.written.filter((w) => w.changed).forEach((w) => log(`Regenerated ${w.file}`));
  if (gen.problems.length) {
    gen.problems.forEach((p) => log(`PROBLEM: ${p}`));
    if (!force) { step('generate', 'failed', `${gen.problems.length} problem(s)`); return { stage: 'generate', aborted: true, problems: gen.problems }; }
  }
  step('generate', 'done', `${gen.written.filter((w) => w.changed).length} manifest(s) changed`);

  // 2. Preflight.
  step('preflight', 'active');
  const pre = [];
  if (packages.includes('campaign')) {
    pre.push(['public', await verify.preflight('public', progress)]);
    pre.push(['beta', await verify.preflight('beta', progress)]);
  }
  if (packages.includes('melee')) pre.push(['melee', await verify.preflightMelee(progress)]);
  const errors = pre.reduce((n, [, r]) => n + r.errors, 0);
  const warnings = pre.reduce((n, [, r]) => n + r.warnings, 0);
  if (errors && !force) {
    step('preflight', 'failed', `${errors} error(s)`);
    return { stage: 'preflight', aborted: true, preflight: Object.fromEntries(pre) };
  }
  step('preflight', 'done', built.length ? `${errors ? `forced past ${errors} error(s), ` : ''}${warnings} warning(s)` : 'launcher only');

  // 3. Launcher artifacts (launcher package only).
  let launcherVersion = null;
  let wouldStage = [];
  if (packages.includes('launcher')) {
    step('stage', 'active');
    // Compared with the live launcher-version.json, so an earlier dry run can't hide a change.
    const published = await r2.publishedLauncherVersion();
    const staged = await r2.stageLauncherArtifacts({ dryRun, published });
    staged.staged.forEach((f) => log(`${dryRun ? 'Would stage' : 'Staged'} ${f}`));
    if (dryRun) wouldStage = staged.staged;
    staged.warnings.forEach((w) => log(`WARNING: ${w}`));
    launcherVersion = await r2.writeLauncherVersion({ dryRun, published, files: staged.files });
    const lv = launcherVersion;
    const versionText = lv.ok ? (lv.previous && lv.previous !== lv.version ? `launcher ${lv.previous} → ${lv.version}` : `launcher ${lv.version} (unchanged)`)
      + (lv.previousSource === 'local' ? ' (live version unreachable; compared with the local file)' : '') : null;
    log(lv.ok ? `launcher-version.json: ${versionText}` : `WARNING: ${lv.error}`);
    step('stage', 'done', versionText ?? 'launcher repo not configured');
  } else {
    step('stage', 'skipped', 'launcher not chosen');
  }

  // 4. Payload first.
  step('payload', 'active');
  const uploads = [];
  for (const folder of cfg.UPLOAD_FOLDERS.filter((f) => packages.includes(f.package))) {
    log(`Uploading ${folder.name}…`);
    const r = await r2.uploadFolder(folder.local, { dryRun, onProgress: progress, onLog: log, cacheControl: r2.CACHE_CONTROL.default });
    uploads.push(r);
    if (!r.ok) { step('payload', 'failed', `${folder.name}: ${r.error}`); throw new Error(`${folder.name} upload failed: ${r.error}`); }
  }
  step('payload', 'done', `${uploads.reduce((n, u) => n + (u.transfers ?? 0), 0)} file(s)`);
  // A dry run doesn't copy the new launcher build in, so rclone can't list it.
  if (wouldStage.length) log(`Dry run: a live deploy would also upload ${wouldStage.join(' and ')} and the new launcher-version.json (${launcherVersion?.version ?? '?'}).`);

  // 5. The CDN has every file at the right size.
  let post = [];
  if (dryRun) step('postflight', 'skipped', 'dry run');
  else {
    step('postflight', 'active');
    if (packages.includes('campaign')) {
      post.push(...await verify.postflight(mf.readManifest(cfg.PUBLIC_MANIFEST), 'public', progress));
      const beta = mf.readManifest(cfg.BETA_MANIFEST);
      if (beta?.betaEnabled) post.push(...await verify.postflight(beta, 'beta', progress));
    }
    if (packages.includes('melee')) post.push(...await verify.postflightMelee(mf.readManifest(cfg.MELEE_MANIFEST), progress));
    if (packages.includes('launcher') && launcherVersion?.ok) post.push(...await verify.postflightLauncher(launcherVersion.doc, progress));
    const bad = post.filter((f) => f.level === 'error');
    if (bad.length && !force) { step('postflight', 'failed', `${bad.length} file(s) wrong or missing`); return { stage: 'postflight', aborted: true, postflight: post, uploads }; }
    step('postflight', 'done', bad.length ? `forced past ${bad.length} error(s)` : 'all files present');
  }

  // 6. Manifests last; only this package's files, never .history or *.bak.json.
  step('manifests', 'active');
  const include = packages.flatMap((p) => MANIFESTS[p]);
  const mu = await r2.uploadFolder(cfg.MANIFEST_FOLDER.local, { dryRun, onProgress: progress, onLog: log, include, exclude: ['.history/**', '*.bak.json'], cacheControl: r2.CACHE_CONTROL.manifests });
  uploads.push(mu);
  if (!mu.ok) { step('manifests', 'failed', mu.error); throw new Error(`Manifest upload failed: ${mu.error}`); }
  step('manifests', 'done', `${mu.transfers ?? 0} file(s)`);

  // 7. Read back.
  let published = null;
  if (dryRun) step('confirm', 'skipped', 'dry run');
  else {
    step('confirm', 'active');
    const files = [];
    if (packages.includes('campaign')) files.push(cfg.PUBLIC_MANIFEST, cfg.BETA_MANIFEST);
    if (packages.includes('melee')) files.push(cfg.MELEE_MANIFEST);
    published = await verify.verifyPublishedManifests(files);
    const bad = published.filter((f) => f.level === 'error');
    step('confirm', bad.length ? 'failed' : 'done', bad.length ? `${bad.length} manifest(s) did not read back` : 'published manifests match');
  }

  // 8. Website download links — last, so the site never points at files that didn't upload.
  const siteResult = updateWebsite({ packages, dryRun, updateSite, log, step, launcherDoc: launcherVersion?.doc });

  log(dryRun ? 'Dry run complete.' : 'Deploy complete.');
  return { stage: 'complete', dryRun, packages, preflight: Object.fromEntries(pre), uploads, postflight: post, published, launcherVersion, site: siteResult };
}

// Publishes only news-feed.json and its re-hosted images (assets/news/), for a quick
// news change between campaign deploys. Nothing is regenerated and no other manifest moves.
async function deployNews({ dryRun = false, force = false, log = () => {}, progress = () => {}, step = () => {} }) {
  const rc = await r2.rcloneAvailable();
  if (!rc.ok) throw new Error(rc.error);
  log('Checking Cloudflare credentials…');
  const probe = await r2.rcloneProbe();
  if (!probe.ok) throw new Error(`R2 check failed (${probe.status}): ${probe.error}`);
  log(`R2 reachable — ${probe.bucket}`);

  step('preflight', 'active');
  const hygiene = verify.checkJsonHygiene(cfg.NEWS_FEED);
  const findings = hygiene.findings.filter((f) => f.code !== 'schema-version');
  if (hygiene.parsed) findings.push(...verify.checkNewsStrings(hygiene.parsed), ...verify.checkNewsFeed(hygiene.parsed));
  const pre = verify.summarize(findings);
  findings.filter((f) => f.level !== 'ok').forEach((f) => log(`${f.level.toUpperCase()}: ${f.message}`));
  if (!hygiene.parsed || (pre.errors && !force)) {
    step('preflight', 'failed', `${pre.errors} error(s)`);
    return { stage: 'preflight', aborted: true, preflight: { news: pre } };
  }
  step('preflight', 'done', `${pre.errors ? `forced past ${pre.errors} error(s), ` : ''}${pre.warnings} warning(s)`);

  step('payload', 'active');
  const uploads = [];
  const images = await r2.uploadFolder('assets', { dryRun, onProgress: progress, onLog: log, include: ['news/**'], cacheControl: r2.CACHE_CONTROL.default });
  uploads.push(images);
  if (!images.ok) { step('payload', 'failed', images.error); throw new Error(`News image upload failed: ${images.error}`); }
  step('payload', 'done', `${images.transfers ?? 0} image(s)`);

  step('manifests', 'active');
  const mu = await r2.uploadFolder(cfg.MANIFEST_FOLDER.local, { dryRun, onProgress: progress, onLog: log, include: ['news-feed.json'], cacheControl: r2.CACHE_CONTROL.manifests });
  uploads.push(mu);
  if (!mu.ok) { step('manifests', 'failed', mu.error); throw new Error(`news-feed.json upload failed: ${mu.error}`); }
  step('manifests', 'done', `${mu.transfers ?? 0} file(s)`);

  let published = null;
  if (dryRun) step('confirm', 'skipped', 'dry run');
  else {
    step('confirm', 'active');
    published = await verify.verifyPublishedManifests([cfg.NEWS_FEED]);
    const bad = published.filter((f) => f.level === 'error');
    step('confirm', bad.length ? 'failed' : 'done', bad.length ? 'news-feed.json did not read back' : 'news-feed.json matches');
  }

  log(dryRun ? 'Dry run complete.' : 'News published.');
  return { stage: 'complete', dryRun, packages: ['news'], preflight: { news: pre }, uploads, published };
}

function updateWebsite({ packages, dryRun, updateSite, log, step, launcherDoc }) {
  const siteRepoPath = cfg.readConfig().siteRepoPath;
  if (!updateSite) { step('site', 'skipped', 'not ticked'); return null; }
  if (!packages.includes('launcher')) { step('site', 'skipped', 'launcher not deployed'); return null; }
  if (!site.siteValid(siteRepoPath)) { step('site', 'skipped', 'website repo path not set (Settings)'); return null; }
  step('site', 'active');
  try {
    const lv = launcherDoc ?? mf.readManifest(cfg.LAUNCHER_VER);
    const r = site.updateSiteLinks({ siteRepoPath, version: lv?.version, portableUrl: lv?.portable?.url, installerUrl: lv?.installer?.url, dryRun });
    if (!r.changed) {
      step('site', 'done', `already ${lv.version}`);
    } else {
      log(`${dryRun ? 'Would update' : 'Updated'} ${r.file}: launcher links → ${lv.version}${dryRun ? '' : ' (uncommitted in the website repo; commit and push to publish)'}`);
      for (const k of Object.keys(r.after)) log(`  ${k}: ${r.before[k]} → ${r.after[k]}`);
      step('site', 'done', `${dryRun ? 'would point' : 'points'} at ${lv.version}${dryRun ? '' : ' — commit & push the site'}`);
    }
    return r;
  } catch (err) {
    // The deploy itself succeeded; a site problem shouldn't read as a failed upload.
    log(`WARNING: website links not updated: ${err.message}`);
    step('site', 'failed', err.message);
    return { error: err.message };
  }
}

module.exports = { deploy, deployNews, MANIFESTS, DEPLOY_PACKAGES };

'use strict';
// The deploy sequence, shared by the GUI (app.js) and the CLI (cli.js).
//
//   probe -> regenerate manifests -> preflight -> stage launcher (campaign)
//   -> upload payload folders -> postflight (CDN HEAD checks) -> upload manifests LAST -> read back
//
// `packages` picks what goes up: ['campaign'], ['melee'] or both. Each package
// uploads only its own payload folders and its own manifests.

const cfg = require('./config');
const catalog = require('./catalog');
const { generate } = require('./generate');
const verify = require('./verify');
const r2 = require('./r2');
const mf = require('./manifest');

const MANIFESTS = {
  campaign: ['update-manifest.json', 'beta-manifest.json', 'news-feed.json', 'launcher-version.json'],
  melee: ['melee-manifest.json'],
};

async function deploy({ packages, dryRun = false, force = false, log = () => {}, progress = () => {}, step = () => {} }) {
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

  // 1. Manifests always match the catalog and the built files.
  step('generate', 'active');
  const gen = await generate({ doc, sc2Root, packages, dryRun: false });
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
  step('preflight', 'done', `${errors ? `forced past ${errors} error(s), ` : ''}${warnings} warning(s)`);

  // 3. Launcher artifacts (campaign deploys only).
  let launcherVersion = null;
  if (packages.includes('campaign')) {
    step('stage', 'active');
    const staged = await r2.stageLauncherArtifacts();
    staged.staged.forEach((f) => log(`Staged ${f}`));
    staged.warnings.forEach((w) => log(`WARNING: ${w}`));
    launcherVersion = r2.writeLauncherVersion();
    log(launcherVersion.ok ? `launcher-version.json -> v${launcherVersion.version}` : `WARNING: ${launcherVersion.error}`);
    step('stage', 'done', launcherVersion.ok ? `launcher v${launcherVersion.version}` : 'launcher repo not configured');
  } else {
    step('stage', 'skipped', 'melee only');
  }

  // 4. Payload first.
  step('payload', 'active');
  const uploads = [];
  for (const folder of cfg.UPLOAD_FOLDERS.filter((f) => packages.includes(f.package))) {
    log(`Uploading ${folder.name}…`);
    const r = await r2.uploadFolder(folder.local, { dryRun, onProgress: progress, onLog: log });
    uploads.push(r);
    if (!r.ok) { step('payload', 'failed', `${folder.name}: ${r.error}`); throw new Error(`${folder.name} upload failed: ${r.error}`); }
  }
  step('payload', 'done', `${uploads.reduce((n, u) => n + (u.transfers ?? 0), 0)} file(s)`);

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
    const bad = post.filter((f) => f.level === 'error');
    if (bad.length && !force) { step('postflight', 'failed', `${bad.length} file(s) wrong or missing`); return { stage: 'postflight', aborted: true, postflight: post, uploads }; }
    step('postflight', 'done', bad.length ? `forced past ${bad.length} error(s)` : 'all files present');
  }

  // 6. Manifests last; only this package's files, never .history or *.bak.json.
  step('manifests', 'active');
  const include = packages.flatMap((p) => MANIFESTS[p]);
  const mu = await r2.uploadFolder(cfg.MANIFEST_FOLDER.local, { dryRun, onProgress: progress, onLog: log, include, exclude: ['.history/**', '*.bak.json'] });
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
  log(dryRun ? 'Dry run complete.' : 'Deploy complete.');
  return { stage: 'complete', dryRun, packages, preflight: Object.fromEntries(pre), uploads, postflight: post, published, launcherVersion };
}

module.exports = { deploy, MANIFESTS };

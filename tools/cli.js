'use strict';
// SCEvo Deploy — command line. Same core as the GUI (run.cmd with no arguments).
//
//   run.cmd init                          create deploy-catalog.json from what's deployed today
//   run.cmd status [--package campaign|melee|meleebeta]
//   run.cmd set <source> [--package campaign|melee] [--channel public|beta|both|off]
//   run.cmd promote <source> public|beta|both
//   run.cmd ignore <source>   /   run.cmd unignore <source>
//   run.cmd build [--package p] [--only <source>]... [--force] [--dry-run]     (p: campaign, melee or meleebeta)
//   run.cmd generate [--package p]
//   run.cmd deploy [--package campaign|melee|meleebeta|launcher|assets[,…]] [--dry-run] [--force] [--update-site]
//                                         assets = the assets/ folder only (replay icons, hero backgrounds, news images)
//   run.cmd beta-tag <source> [off]       tag a mod for the melee beta's branch (or untag it)
//   run.cmd melee-beta [--on|--off] [--name "…"] [--code CODE] [--version 1.0] [--accent #ff6600]
//   run.cmd offline-zip                   zip the public campaign package for offline play (offline/)
//   run.cmd cdn-check [https://host]       is the custom CDN address ready? (default: cdnBase in deploy-config.json)
//   run.cmd decals [exclude|include <id>] list the melee decals that look blank, or leave a decal out / back in
//   run.cmd check <blog [id]|site|launcher|assets|mods|cdn|all> [--quick]   pre-push checks (tools/check.js)
// <source> is the path inside the SC2 install, e.g. "Maps\SCEvo_MPMaps\SEL_1v1\Golden Wall SEL.SC2Map",
// or just the file name when it's unique. Exits non-zero on failure.

const path = require('node:path');
const fs = require('node:fs');
const cfg = require('./lib/config');
const catalog = require('./lib/catalog');
const { build, adoptExisting, statusOf } = require('./lib/build');
const { generate } = require('./lib/generate');
const { deploy } = require('./lib/deploy');
const { seed } = require('./lib/seed');
const hashcache = require('./lib/hashcache');

function parse(argv) {
  const args = { _: [], only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--package') args.package = argv[++i];
    else if (a === '--channel') args.channel = argv[++i];
    else if (a === '--only') args.only.push(argv[++i]);
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--update-site') args.updateSite = true;
    else if (a === '--on') args.on = true;
    else if (a === '--off') args.off = true;
    else if (['--name', '--code', '--version', '--accent'].includes(a)) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

const log = (m) => console.log(m);
const packagesOf = (args) => {
  if (!args.package) return catalog.BUILD_PACKAGES;
  if (!catalog.BUILD_PACKAGES.includes(args.package)) throw new Error(`--package must be one of ${catalog.BUILD_PACKAGES.join(', ')}`);
  return [args.package];
};

function sc2Root() {
  const root = cfg.readConfig().sc2InstallPath;
  if (!root || !fs.existsSync(root)) throw new Error('sc2InstallPath is not set in deploy-config.json (or the folder is missing)');
  return root;
}

function loadCatalog() {
  const doc = catalog.load();
  if (!doc) throw new Error('No deploy-catalog.json yet. Run: run.cmd init');
  return doc;
}

// Accepts a full source path or a unique file name.
function resolveSource(doc, root, query) {
  if (!query) throw new Error('Missing <source>');
  const { rows } = catalog.classify(doc, root);
  const exact = rows.find((r) => catalog.keyOf(r.source) === catalog.keyOf(query));
  if (exact) return exact.source;
  const byName = rows.filter((r) => path.basename(r.source).toLowerCase() === path.basename(query).toLowerCase());
  if (byName.length === 1) return byName[0].source;
  if (byName.length > 1) throw new Error(`"${query}" matches several sources:\n  ${byName.map((r) => r.source).join('\n  ')}`);
  throw new Error(`No source matches "${query}"`);
}

const commands = {
  async init() {
    if (catalog.load()) throw new Error('deploy-catalog.json already exists');
    const doc = seed();
    catalog.save(doc);
    log(`Created deploy-catalog.json: ${doc.items.length} item(s), ${doc.ignore.length} ignored`);
    await adoptExisting(doc, sc2Root(), log);
  },

  async 'cdn-check'(args) {
    const base = args._[1] || cfg.readConfig().cdnBase;
    if (!base) throw new Error('Usage: run.cmd cdn-check https://your.cdn.domain (or set cdnBase in deploy-config.json)');
    const r = await require('./lib/cdncheck').cdnCheck(base);
    for (const c of r.checks) log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}${c.hint ? `\n       → ${c.hint}` : ''}`);
    log(r.ready ? `\n${r.base} is ready. Set it as the CDN address (Settings, or "cdnBase" in deploy-config.json).` : `\n${r.base} is not ready yet.`);
    if (!r.ready) process.exitCode = 1;
  },

  async decals(args) {
    const doc = loadCatalog();
    const [, action, id] = args._;
    const list = new Set(doc.melee.decalExclude || []);
    if (action === 'exclude' || action === 'include') {
      if (!/^Decal_(Terran|Zerg|Protoss)_\w+$/i.test(id || '')) throw new Error('Usage: run.cmd decals exclude|include Decal_Zerg_0083_01');
      if (action === 'exclude') list.add(id); else list.delete(id);
      doc.melee.decalExclude = [...list];
      catalog.save(doc);
      log(`${action === 'exclude' ? 'Excluded' : 'Included'} ${id}. Run "build --package melee" to update the decal package.`);
      return;
    }
    const { buildDecals } = require('./lib/decals');
    const r = buildDecals({ exclude: [...list], dryRun: true, log });
    log(`Excluded: ${list.size ? [...list].join(', ') : 'none'}`);
    if (r.blank.length) log(`Look blank: ${r.blank.join(', ')}`);
  },

  async status(args) {
    const doc = loadCatalog();
    const root = sc2Root();
    const { rows, missingRoots } = catalog.classify(doc, root);
    const st = statusOf(doc, rows);
    const pkgs = packagesOf(args);
    missingRoots.forEach((r) => log(`! root not found: ${r}`));
    const fresh = rows.filter((r) => r.status === 'new');
    if (fresh.length) {
      log(`\nNew (decide with "set" or "ignore"):`);
      fresh.forEach((r) => log(`  ${r.source}${r.packed ? '  [packed]' : ''}`));
    }
    for (const pkg of pkgs) {
      log(`\n${pkg}:`);
      if (pkg === 'meleebeta') {
        const tagged = rows.filter((x) => x.item?.meleeBeta);
        if (!tagged.length) log('  (no mods tagged: run.cmd beta-tag <mod>)');
        tagged.forEach((r) => log(`  tagged   ${r.status === 'missing' ? 'MISSING SOURCE' : ''}${r.source}`));
        continue;
      }
      for (const r of rows.filter((x) => x.item && x.item.package === pkg)) {
        const s = r.status === 'missing' ? 'MISSING SOURCE' : st.get(catalog.keyOf(r.source));
        log(`  ${r.item.channel.padEnd(6)} ${String(s).padEnd(8)} ${r.source}`);
      }
    }
    log(`\n${doc.ignore.length} ignored.`);
    const pend = await require('./lib/pending').pendingPackages();
    log(pend.offline ? '\nCould not reach the CDN to compare manifests.' : '');
    for (const [pkg, p] of Object.entries(pend.packages)) log(`${pkg}: ${p.changed ? `not deployed yet (${p.details.join(', ')})` : 'same as the live CDN'}`);
  },

  async set(args) {
    const doc = loadCatalog();
    const source = resolveSource(doc, sc2Root(), args._[1]);
    const patch = {};
    if (args.package) patch.package = args.package;
    if (args.channel) patch.channel = args.channel;
    catalog.upsert(doc, source, patch);
    catalog.save(doc);
    const it = catalog.findItem(doc, source);
    log(`${source}: ${it.package} / ${it.channel}${it.mapId ? ` (map id ${it.mapId})` : ''}`);
  },

  async promote(args) {
    const channel = args._[2];
    if (!['public', 'beta', 'both'].includes(channel)) throw new Error('Usage: run.cmd promote <source> public|beta|both');
    await commands.set({ ...args, _: ['set', args._[1]], channel });
    log('Run "build" to move the file and update the manifests.');
  },

  async ignore(args) {
    const doc = loadCatalog();
    const source = resolveSource(doc, sc2Root(), args._[1]);
    catalog.ignore(doc, source);
    catalog.save(doc);
    log(`Ignored ${source}`);
  },

  async unignore(args) {
    const doc = loadCatalog();
    const source = resolveSource(doc, sc2Root(), args._[1]);
    catalog.unignore(doc, source);
    catalog.save(doc);
    log(`${source} is no longer ignored (it shows as new until you decide)`);
  },

  async 'beta-tag'(args) {
    const doc = loadCatalog();
    const source = resolveSource(doc, sc2Root(), args._[1]);
    const meleebeta = require('./lib/meleebeta');
    const off = args._[2] === 'off';
    if (!off && !meleebeta.canTag(source)) throw new Error(`Only mods in "${meleebeta.MOD_DIR}" can be tagged for the melee beta`);
    if (!catalog.findItem(doc, source)) throw new Error(`${source} isn't in the catalog yet: add it with "set" first`);
    catalog.upsert(doc, source, { meleeBeta: off ? null : true });
    catalog.save(doc);
    log(`${source}: ${off ? 'no longer in' : 'tagged for'} the melee beta. Run "build --package meleebeta" to update it.`);
    const problems = meleebeta.closureProblems(doc, catalog.classify(doc, sc2Root()).rows);
    problems.forEach((p) => log(`NOTE: ${p}`));
  },

  async 'melee-beta'(args) {
    const doc = loadCatalog();
    const o = {};
    if (args.on) o.enabled = true;
    if (args.off) o.enabled = false;
    for (const k of ['name', 'code', 'version']) if (args[k] != null) o[k] = args[k];
    if (args.accent != null) o.accentColor = args.accent;
    const { written, problems, docs } = await generate({ doc, sc2Root: sc2Root(), packages: ['meleebeta'], overrides: { meleeBeta: o } });
    const d = docs.meleeBeta;
    log(`Melee beta: ${d.betaEnabled ? 'ON' : 'off'} · "${d.betaName}" · version ${d.version || '—'} · code ${d.codeHash ? 'set' : 'not set'} · ${d.modules?.length ?? 0} mod(s)`);
    written.forEach((w) => log(`${w.changed ? 'wrote    ' : 'unchanged'} ${w.file}`));
    problems.forEach((p) => log(`PROBLEM: ${p}`));
    if (problems.length) process.exitCode = 1;
  },

  async build(args) {
    const doc = loadCatalog();
    const only = args.only.length ? args.only.map((q) => resolveSource(doc, sc2Root(), q)) : null;
    const { results, pruned, problems = [] } = await build({
      doc, sc2Root: sc2Root(), packages: packagesOf(args), only, force: !!args.force, dryRun: !!args.dryRun, log,
      progress: (p) => { if (p.phase === 'start') log(`[${p.index}/${p.total}] ${p.file}`); },
    });
    const failed = results.filter((r) => !r.ok);
    log(`\n${results.length - failed.length} ok, ${failed.length} failed, ${pruned.length} removed`);
    problems.forEach((p) => log(`PROBLEM: ${p}`));
    if (failed.length || problems.length) { process.exitCode = 1; return; }
    if (!args.dryRun) await commands.generate(args);
  },

  async generate(args) {
    const doc = loadCatalog();
    const { written, problems } = await generate({ doc, sc2Root: sc2Root(), packages: packagesOf(args) });
    written.forEach((w) => log(`${w.changed ? 'wrote    ' : 'unchanged'} ${w.file}`));
    problems.forEach((p) => log(`PROBLEM: ${p}`));
    if (problems.length) process.exitCode = 1;
  },

  async deploy(args) {
    const { DEPLOY_PACKAGES } = require('./lib/deploy');
    // --package launcher,assets ships several at once.
    const chosen = args.package ? String(args.package).split(',').map((p) => p.trim()).filter(Boolean) : DEPLOY_PACKAGES;
    const bad = chosen.filter((p) => !DEPLOY_PACKAGES.includes(p));
    if (bad.length) throw new Error(`--package must be one of ${DEPLOY_PACKAGES.join(', ')} (or several, comma-separated)`);
    const r = await deploy({
      packages: chosen, dryRun: !!args.dryRun, force: !!args.force, updateSite: !!args.updateSite, log,
      step: (id, state, detail) => log(`-- ${id}: ${state}${detail ? ` (${detail})` : ''}`),
    });
    if (r.aborted) { log(`Aborted at ${r.stage}.`); process.exitCode = 1; }
  },

  async 'offline-zip'() {
    let shown = -1;
    const r = await require('./lib/offline').buildOfflineZip({
      log,
      onProgress: (p) => {
        const pct = Math.floor((p.doneBytes / p.totalBytes) * 100);
        if (pct >= shown + 10) { shown = pct - (pct % 10); log(`  ${pct}%  ${p.name}`); }
      },
    });
    log(r.file);
  },
};

async function main() {
  const args = parse(process.argv.slice(2));
  const cmd = commands[args._[0]];
  if (!cmd) {
    const lines = fs.readFileSync(__filename, 'utf8').split('\n').slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exitCode = args._[0] && args._[0] !== 'help' ? 1 : 0;
    return;
  }
  try {
    await cmd(args);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    hashcache.flush();
  }
}

main();

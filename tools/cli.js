'use strict';
// SCEvo Deploy — command line. Same core as the GUI (run.cmd with no arguments).
//
//   run.cmd init                          create deploy-catalog.json from what's deployed today
//   run.cmd status [--package campaign|melee]
//   run.cmd set <source> [--package campaign|melee] [--channel public|beta|both|off]
//   run.cmd promote <source> public|beta|both
//   run.cmd ignore <source>   /   run.cmd unignore <source>
//   run.cmd build [--package p] [--only <source>]... [--force] [--dry-run]
//   run.cmd generate [--package p]
//   run.cmd deploy [--package p] [--dry-run] [--force] [--update-site]
//
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
    else args._.push(a);
  }
  return args;
}

const log = (m) => console.log(m);
const packagesOf = (args) => {
  if (!args.package) return catalog.PACKAGES;
  if (!catalog.PACKAGES.includes(args.package)) throw new Error(`--package must be one of ${catalog.PACKAGES.join(', ')}`);
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
      for (const r of rows.filter((x) => x.item && x.item.package === pkg)) {
        const s = r.status === 'missing' ? 'MISSING SOURCE' : st.get(catalog.keyOf(r.source));
        log(`  ${r.item.channel.padEnd(6)} ${String(s).padEnd(8)} ${r.source}`);
      }
    }
    log(`\n${doc.ignore.length} ignored.`);
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

  async build(args) {
    const doc = loadCatalog();
    const only = args.only.length ? args.only.map((q) => resolveSource(doc, sc2Root(), q)) : null;
    const { results, pruned } = await build({
      doc, sc2Root: sc2Root(), packages: packagesOf(args), only, force: !!args.force, dryRun: !!args.dryRun, log,
      progress: (p) => { if (p.phase === 'start') log(`[${p.index}/${p.total}] ${p.file}`); },
    });
    const failed = results.filter((r) => !r.ok);
    log(`\n${results.length - failed.length} ok, ${failed.length} failed, ${pruned.length} removed`);
    if (failed.length) { process.exitCode = 1; return; }
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
    const r = await deploy({
      packages: packagesOf(args), dryRun: !!args.dryRun, force: !!args.force, updateSite: !!args.updateSite, log,
      step: (id, state, detail) => log(`-- ${id}: ${state}${detail ? ` (${detail})` : ''}`),
    });
    if (r.aborted) { log(`Aborted at ${r.stage}.`); process.exitCode = 1; }
  },
};

async function main() {
  const args = parse(process.argv.slice(2));
  const cmd = commands[args._[0]];
  if (!cmd) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
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

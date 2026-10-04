'use strict';
// Generates update-manifest.json, beta-manifest.json and melee-manifest.json
// from the catalog and the built payload files. Nothing here is edited by hand:
// what ships is exactly what the catalog says, at the hashes on disk.
//
// Hand-edited settings (versions, criticalUpdate, beta name/code/theme) are
// carried over from the current manifest, or taken from `overrides`.

const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const catalog = require('./catalog');
const mf = require('./manifest');
const { hashOf } = require('./hashcache');
const { destsOf, thumbPathOf, loadState } = require('./build');
const { readMapMeta, modesFor } = require('./mapmeta');

const baseName = (p) => path.basename(p, path.extname(p));

// Groups consecutive items that share a module id (a module can hold several files).
function groupModules(entries) {
  const modules = [];
  const byId = new Map();
  for (const { item, file } of entries) {
    const meta = item.module || {};
    const id = meta.id || mf.moduleIdFor(path.basename(item.source));
    let m = byId.get(id);
    if (!m) {
      m = { id, name: meta.name || baseName(item.source), description: meta.description || baseName(item.source), type: meta.type || '', files: [] };
      byId.set(id, m);
      modules.push(m);
    }
    m.files.push(file);
  }
  return modules;
}

async function fileEntry(item, abs, manifestPath) {
  const { hash, size } = await hashOf(abs);
  const file = { name: path.basename(manifestPath), path: manifestPath, size, hash };
  if (Array.isArray(item.downloadUrls) && item.downloadUrls.length) file.downloadUrls = item.downloadUrls;
  else if (item.downloadUrl) file.downloadUrl = item.downloadUrl;
  return file;
}

// Campaign files for one channel ("public" or "beta"), in catalog order.
async function campaignEntries(doc, channel, problems) {
  const out = [];
  for (const item of doc.items) {
    if (item.package !== 'campaign' || !catalog.channelsOf(item).includes(channel)) continue;
    const target = catalog.targetOf(item);
    const abs = path.join(cfg.OUTPUT_DIRS.campaign[channel], ...target.split('/'));
    if (!fs.existsSync(abs)) { problems.push(`${target} is set to ${channel} but isn't built — run Build`); continue; }
    out.push({ item, file: await fileEntry(item, abs, target) });
  }
  return out;
}

async function meleeDoc(doc, sc2Root, overrides, problems) {
  const state = loadState();
  const modules = [];
  const maps = [];
  const meleeMods = new Set();
  for (const item of doc.items) {
    if (item.package !== 'melee' || !catalog.channelsOf(item).length) continue;
    const [abs] = destsOf(item);
    if (!fs.existsSync(abs)) { problems.push(`${item.source} is in the melee package but isn't built — run Build`); continue; }
    if (!catalog.isMap(item.source)) {
      const target = catalog.targetOf(item);
      meleeMods.add(target.toLowerCase());
      modules.push({ item, file: await fileEntry(item, abs, target) });
      continue;
    }
    const st = state[catalog.keyOf(item.source)];
    const meta = st && st.meta ? st.meta : (() => { const { thumbnail, ...m } = readMapMeta(abs, { sc2Root }); return m; })();
    const file = await hashOf(abs);
    const entry = {
      id: item.mapId,
      name: item.name || meta.name,
      description: item.description ?? meta.description ?? '',
      modes: item.modes || modesFor(meta.modes, meta.players),
      players: meta.players,
      size: meta.size || null,
      tileset: meta.tileset || null,
      requiresMods: meta.requiresMods || [],
      file: { path: catalog.targetOf(item), size: file.size, hash: file.hash },
    };
    const thumb = thumbPathOf(item);
    if (fs.existsSync(thumb)) {
      const t = await hashOf(thumb);
      entry.thumbnail = { path: `thumbs/${item.mapId}.png`, size: t.size, hash: t.hash };
    }
    maps.push(entry);
  }

  // Every mod a map needs must ship somewhere: in the melee package or in the
  // campaign mods the melee package requires.
  const campaignPaths = new Set(doc.items.filter((i) => i.package === 'campaign' && catalog.channelsOf(i).includes('public'))
    .map((i) => catalog.targetOf(i).toLowerCase()));
  for (const m of maps) {
    for (const req of m.requiresMods) {
      const k = req.toLowerCase();
      if (!meleeMods.has(k) && !campaignPaths.has(k)) problems.push(`${m.name} needs ${req}, which is in neither the melee package nor the public campaign`);
    }
  }

  return {
    schemaVersion: cfg.SCHEMA_VERSION,
    lastUpdated: mf.nowIso(),
    version: String(overrides.version ?? doc.melee.version),
    requires: doc.melee.requires,
    modules: mf.serializeModules(groupModules(modules)),
    maps,
  };
}

// Same content apart from lastUpdated?
const sameContent = (a, b) => {
  if (!a || !b) return false;
  const strip = ({ lastUpdated, ...rest }) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

function writeIfChanged(file, doc, dryRun) {
  const current = mf.readManifest(file);
  if (sameContent(current, doc)) return { file: path.basename(file), changed: false };
  if (!dryRun) mf.writeManifest(file, doc);
  return { file: path.basename(file), changed: true };
}

/**
 * opts: { doc, sc2Root, packages, overrides: { public: {versions, criticalUpdate}, beta: {meta, criticalUpdate}, melee: {version} }, dryRun }
 * Returns { written: [{file, changed}], problems: [string], docs: {public, beta, melee} }.
 */
async function generate(opts) {
  const { doc, sc2Root, packages = catalog.PACKAGES, overrides = {}, dryRun = false } = opts;
  const problems = [];
  const written = [];
  const docs = {};

  if (packages.includes('campaign')) {
    const pub = mf.readManifest(cfg.PUBLIC_MANIFEST) || {};
    const o = overrides.public || {};
    docs.public = mf.buildPublicManifest({
      versions: o.versions ?? pub.versions,
      criticalUpdate: o.criticalUpdate ?? pub.criticalUpdate,
      modules: groupModules(await campaignEntries(doc, 'public', problems)),
    });

    const beta = mf.readManifest(cfg.BETA_MANIFEST) || {};
    const ob = overrides.beta || {};
    const meta = {
      betaEnabled: beta.betaEnabled, betaName: beta.betaName, majorVersion: beta.majorVersion,
      fullVersion: beta.fullVersion, codeHash: beta.codeHash, accentColor: beta.theme?.accentColor,
      ...(ob.meta || {}),
    };
    docs.beta = mf.buildBetaManifest({
      meta,
      criticalUpdate: ob.criticalUpdate ?? beta.criticalUpdate,
      modules: groupModules(await campaignEntries(doc, 'beta', problems)),
      coreVersion: ob.meta?.coreVersion ?? beta.versions?.multiplayer,
    });

    written.push(writeIfChanged(cfg.PUBLIC_MANIFEST, docs.public, dryRun));
    written.push(writeIfChanged(cfg.BETA_MANIFEST, docs.beta, dryRun));
  }

  if (packages.includes('melee')) {
    docs.melee = await meleeDoc(doc, sc2Root, overrides.melee || {}, problems);
    written.push(writeIfChanged(cfg.MELEE_MANIFEST, docs.melee, dryRun));
  }

  return { written, problems, docs };
}

module.exports = { generate, groupModules, sameContent };

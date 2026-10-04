'use strict';
// deploy-catalog.json: the single, committed record of what gets deployed.
//
// Every source the tool can see (a .SC2Mod / .SC2Map folder or packed file under
// one of the catalog's roots) is either an item (with a package and a channel)
// or ignored. Manifests and payload folders are derived from this file, so
// "move a map to beta" is one field change, and an ignored mod stays ignored
// across sessions, machines and git operations.
//
//   package: "campaign" | "melee"
//   channel: campaign "public" | "beta" | "both" | "off";  melee "public" | "off"

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CATALOG_PATH, DEFAULT_ROOTS, stripJunk, writeTextAtomic } = require('./config');

const PACKAGES = ['campaign', 'melee'];
const CHANNELS = { campaign: ['public', 'beta', 'both', 'off'], melee: ['public', 'off'] };
const SC2_EXT = /\.(sc2mod|sc2map)$/i;

const keyOf = (source) => String(source).replace(/\//g, '\\').toLowerCase();

function emptyCatalog() {
  return {
    schemaVersion: 1,
    roots: DEFAULT_ROOTS.map((r) => ({ ...r })),
    melee: {
      version: '1.0.0',
      requires: [
        'Mods/SC Evolution Complete/SCEvo_Core.SC2Mod',
        'Mods/SC Evolution Complete/SCEvo_Assets.SC2Mod',
      ],
    },
    items: [],
    ignore: [],
  };
}

function load(file = CATALOG_PATH) {
  if (!fs.existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(stripJunk(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    // Never fall back to an empty catalog: that would silently re-flag every
    // ignored mod as new, which is the exact bug this file exists to fix.
    throw new Error(`${path.basename(file)} is not valid JSON: ${err.message}`);
  }
  return validate(doc);
}

function validate(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') throw new Error('catalog: not an object');
  doc.roots = Array.isArray(doc.roots) ? doc.roots : [];
  doc.items = Array.isArray(doc.items) ? doc.items : [];
  doc.ignore = Array.isArray(doc.ignore) ? doc.ignore : [];
  doc.melee = { ...emptyCatalog().melee, ...(doc.melee || {}) };
  const seen = new Set();
  for (const it of doc.items) {
    if (!it.source) { problems.push('an item has no source'); continue; }
    const k = keyOf(it.source);
    if (seen.has(k)) problems.push(`duplicate item: ${it.source}`);
    seen.add(k);
    if (!PACKAGES.includes(it.package)) problems.push(`${it.source}: unknown package "${it.package}"`);
    else if (!CHANNELS[it.package].includes(it.channel)) problems.push(`${it.source}: channel "${it.channel}" is not valid for ${it.package}`);
    if (it.package === 'melee' && isMap(it.source) && !/^[0-9a-f]{10}$/.test(String(it.mapId || ''))) {
      problems.push(`${it.source}: melee maps need a 10-hex mapId`);
    }
  }
  for (const s of doc.ignore) if (seen.has(keyOf(s))) problems.push(`${s} is both an item and ignored`);
  if (problems.length) throw new Error(`deploy-catalog.json has problems:\n  - ${problems.join('\n  - ')}`);
  return doc;
}

// Stable key order and 2-space JSON, so every edit is a small, readable diff.
function save(doc, file = CATALOG_PATH) {
  validate(doc);
  const ordered = {
    schemaVersion: 1,
    roots: doc.roots,
    melee: { version: doc.melee.version, requires: doc.melee.requires },
    items: doc.items.map(orderItem),
    ignore: [...doc.ignore].sort((a, b) => a.localeCompare(b)),
  };
  writeTextAtomic(file, JSON.stringify(ordered, null, 2) + '\n');
  return ordered;
}

const ITEM_KEYS = ['source', 'package', 'channel', 'target', 'mapId', 'name', 'description', 'module', 'downloadUrl', 'downloadUrls'];
function orderItem(it) {
  const out = {};
  for (const k of ITEM_KEYS) if (it[k] !== undefined && it[k] !== null && it[k] !== '') out[k] = it[k];
  return out;
}

const isMap = (source) => /\.sc2map$/i.test(source);

/* ── paths ───────────────────────────────────────────────────────────────── */

// SC2-install-relative manifest path ("Maps/…", "Mods/…") for a source.
function installPathOf(source) {
  let rel = String(source).replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^mods\//i.test(rel)) rel = 'Mods' + rel.slice(4);
  if (/^maps\//i.test(rel)) rel = 'Maps' + rel.slice(4);
  return rel;
}

// Where an item's built file goes inside its payload folder.
// Campaign files and melee mods keep their install path; melee maps get an
// opaque name so neither the CDN nor %APPDATA% reveals what they are.
function targetOf(item) {
  if (item.target) return item.target;
  if (item.package === 'melee' && isMap(item.source)) return `maps/${item.mapId}.evm`;
  return installPathOf(item.source);
}

const newMapId = () => crypto.randomBytes(5).toString('hex');

/* ── scanning the SC2 install ────────────────────────────────────────────── */

// readdir reports a Windows junction as a symlink, not a directory. The SC2
// install uses junctions heavily, so follow them.
function isDirEntry(dirent, full) {
  if (dirent.isDirectory()) return true;
  if (dirent.isSymbolicLink()) { try { return fs.statSync(full).isDirectory(); } catch { return false; } }
  return false;
}

// Every .SC2Mod / .SC2Map under the roots: folder sources and packed single files.
function discover(sc2Root, roots) {
  const found = [];
  const missingRoots = [];
  const seen = new Set();
  const add = (rel, full, kind) => {
    const k = keyOf(rel);
    if (seen.has(k)) return;
    seen.add(k);
    let st;
    try { st = fs.statSync(full); } catch { return; }
    found.push({ source: rel, abs: full, kind, packed: !st.isDirectory() });
  };
  for (const root of roots) {
    const full = path.join(sc2Root, root.rel);
    if (!fs.existsSync(full)) { missingRoots.push(root.rel); continue; }
    if (root.single) { add(root.rel, full, root.kind); continue; }
    const walk = (dirRel, dirAbs, depth) => {
      for (const e of fs.readdirSync(dirAbs, { withFileTypes: true })) {
        const childAbs = path.join(dirAbs, e.name);
        const childRel = path.join(dirRel, e.name);
        if (SC2_EXT.test(e.name)) {
          const kind = /\.sc2map$/i.test(e.name) ? 'map' : 'mod';
          if (!root.kind || root.kind === kind) add(childRel, childAbs, kind);
        } else if (depth > 1 && isDirEntry(e, childAbs)) {
          walk(childRel, childAbs, depth - 1);
        }
      }
    };
    walk(root.rel, full, root.depth || 1);
  }
  found.sort((a, b) => a.source.localeCompare(b.source));
  return { found, missingRoots };
}

// Joins what's on disk with the catalog:
//   status "new" (no decision yet), "tracked", "ignored", or "missing" (an item whose source is gone).
function classify(doc, sc2Root) {
  const { found, missingRoots } = discover(sc2Root, doc.roots);
  const items = new Map(doc.items.map((it) => [keyOf(it.source), it]));
  const ignored = new Set(doc.ignore.map(keyOf));
  const rows = found.map((f) => {
    const k = keyOf(f.source);
    const item = items.get(k);
    return { ...f, status: item ? 'tracked' : ignored.has(k) ? 'ignored' : 'new', item: item || null };
  });
  const foundKeys = new Set(found.map((f) => keyOf(f.source)));
  for (const it of doc.items) {
    if (!foundKeys.has(keyOf(it.source))) rows.push({ source: it.source, abs: null, kind: isMap(it.source) ? 'map' : 'mod', status: 'missing', item: it });
  }
  return { rows, missingRoots };
}

/* ── edits (all return the updated doc; callers save) ────────────────────── */

function findItem(doc, source) {
  return doc.items.find((it) => keyOf(it.source) === keyOf(source)) || null;
}

// Adds or updates an item. Removes it from the ignore list if it was there.
function upsert(doc, source, patch) {
  doc.ignore = doc.ignore.filter((s) => keyOf(s) !== keyOf(source));
  let it = findItem(doc, source);
  if (!it) { it = { source, package: 'campaign', channel: 'off' }; doc.items.push(it); }
  Object.assign(it, patch);
  if (it.package === 'melee' && !CHANNELS.melee.includes(it.channel)) it.channel = it.channel === 'off' ? 'off' : 'public';
  if (it.package === 'melee' && isMap(it.source) && !it.mapId) it.mapId = newMapId();
  return doc;
}

function ignore(doc, source) {
  doc.items = doc.items.filter((it) => keyOf(it.source) !== keyOf(source));
  if (!doc.ignore.some((s) => keyOf(s) === keyOf(source))) doc.ignore.push(source);
  return doc;
}

function unignore(doc, source) {
  doc.ignore = doc.ignore.filter((s) => keyOf(s) !== keyOf(source));
  return doc;
}

// Which payload channels an item's file must be present in.
function channelsOf(item) {
  if (item.channel === 'off') return [];
  if (item.channel === 'both') return ['public', 'beta'];
  return [item.channel];
}

module.exports = {
  PACKAGES, CHANNELS, keyOf, isMap, emptyCatalog, load, save, validate,
  installPathOf, targetOf, newMapId, discover, classify, findItem, upsert, ignore, unignore, channelsOf,
};

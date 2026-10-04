'use strict';
// Builds payload folders from the catalog.
//
// For every item that's switched on, its file must exist in each of its
// channels' payload folders:
//   - unchanged source + file already built  -> nothing to do
//   - unchanged source, file in the wrong channel only (promote/demote) -> copy
//   - changed or never built -> package (folder source) or copy (packed source)
// Files in a payload folder that no item claims any more are removed, so the
// folders always mirror the catalog.

const fs = require('node:fs');
const path = require('node:path');
const { CACHE_DIR, OUTPUT_DIRS, MPQ_EDITOR, writeJsonAtomic, ensureCacheDir } = require('./config');
const catalog = require('./catalog');
const mpq = require('./mpq');
const { hashOf } = require('./hashcache');
const { readMapMeta } = require('./mapmeta');

const STATE_FILE = path.join(CACHE_DIR, 'build-state.json');
const BUILT_EXT = /\.(sc2map|sc2mod|evm|png)$/i;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(state) { ensureCacheDir(); writeJsonAtomic(STATE_FILE, state); }

// Cheap change detection for a source: count, total size and newest mtime of
// every file (following junctions). A packed source is just its own size+mtime.
function fingerprint(abs) {
  const st = fs.statSync(abs);
  if (!st.isDirectory()) return `f|${st.size}|${Math.round(st.mtimeMs)}`;
  let count = 0, size = 0, newest = 0;
  const seen = new Set();
  const walk = (dir) => {
    let real;
    try { real = fs.realpathSync(dir).toLowerCase(); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      let s;
      try { s = fs.statSync(full); } catch { continue; }
      if (s.isDirectory()) walk(full);
      else { count++; size += s.size; if (s.mtimeMs > newest) newest = s.mtimeMs; }
    }
  };
  walk(abs);
  return `d|${count}|${size}|${Math.round(newest)}`;
}

// Absolute payload paths an item's file must exist at.
function destsOf(item) {
  const target = catalog.targetOf(item);
  return catalog.channelsOf(item).map((ch) => path.join(OUTPUT_DIRS[item.package][ch], ...target.split('/')));
}

function thumbPathOf(item) {
  return path.join(OUTPUT_DIRS.melee.public, 'thumbs', `${item.mapId}.png`);
}

function sameFile(abs, size) {
  try { return fs.statSync(abs).size === size; } catch { return false; }
}

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

/**
 * opts: { doc, sc2Root, packages = ['campaign','melee'], only (source list), force, dryRun, log, progress }
 * Returns { results: [{source, action, ok, error?}], pruned: [paths] }.
 */
async function build(opts) {
  const { doc, sc2Root, packages = catalog.PACKAGES, only = null, force = false, dryRun = false } = opts;
  const log = opts.log || (() => {});
  const progress = opts.progress || (() => {});
  const state = loadState();
  const { rows } = catalog.classify(doc, sc2Root);
  const byKey = new Map(rows.map((r) => [catalog.keyOf(r.source), r]));
  const onlyKeys = only ? new Set(only.map(catalog.keyOf)) : null;

  const items = doc.items.filter((it) => packages.includes(it.package) && catalog.channelsOf(it).length);
  const todo = items.filter((it) => !onlyKeys || onlyKeys.has(catalog.keyOf(it.source)));
  const results = [];
  let index = 0;

  for (const item of todo) {
    index++;
    const row = byKey.get(catalog.keyOf(item.source));
    const name = path.basename(item.source);
    progress({ phase: 'start', file: name, index, total: todo.length });
    if (!row || !row.abs) { results.push({ source: item.source, ok: false, action: 'missing', error: 'source not found in the SC2 install' }); continue; }

    try {
      const fp = fingerprint(row.abs);
      const prev = state[catalog.keyOf(item.source)];
      const dests = destsOf(item);
      const fresh = !force && prev && prev.fingerprint === fp;
      const have = fresh ? dests.filter((d) => sameFile(d, prev.size)) : [];

      let action;
      if (fresh && have.length === dests.length) {
        action = 'up-to-date';
      } else if (fresh && have.length) {
        action = 'copied';
        if (!dryRun) for (const d of dests) if (!have.includes(d)) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(have[0], d); }
      } else if (row.packed) {
        action = 'copied-packed';
        if (!dryRun) {
          const header = mpq.readMpqHeader(row.abs);
          if (!header) throw new Error('not an MPQ archive');
          for (const d of dests) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(row.abs, d); }
        }
      } else {
        action = 'packaged';
        if (!dryRun) {
          if (!fs.existsSync(MPQ_EDITOR)) throw new Error(`MPQEditor.exe not found at ${MPQ_EDITOR}`);
          const r = await mpq.buildOne({ relPath: item.source, sourceDir: row.abs }, dests, progress);
          if (!r.ok) throw new Error(r.error);
        }
      }

      if (!dryRun && action !== 'up-to-date') {
        const { hash, size } = await hashOf(dests[0]);
        state[catalog.keyOf(item.source)] = { fingerprint: fp, hash, size };
      }

      // Melee maps: thumbnail + metadata, refreshed whenever the archive changes.
      if (!dryRun && item.package === 'melee' && catalog.isMap(item.source)) {
        const st = state[catalog.keyOf(item.source)];
        const thumb = thumbPathOf(item);
        if (!st.meta || st.meta.hash !== st.hash || !fs.existsSync(thumb)) {
          const meta = readMapMeta(dests[0], { sc2Root });
          fs.mkdirSync(path.dirname(thumb), { recursive: true });
          if (meta.thumbnail) fs.writeFileSync(thumb, meta.thumbnail);
          const { thumbnail, ...rest } = meta;
          st.meta = { hash: st.hash, ...rest };
          if (!meta.supported) log(`WARNING: ${name} is not a supported melee map (${meta.reason})`);
        }
      }

      if (action !== 'up-to-date') log(`${action === 'packaged' ? 'Packaged' : 'Copied'} ${name} -> ${dests.length} channel(s)`);
      results.push({ source: item.source, ok: true, action });
    } catch (err) {
      log(`FAILED ${name}: ${err.message}`);
      results.push({ source: item.source, ok: false, action: 'error', error: err.message });
    }
    if (!dryRun) saveState(state);
  }

  // Prune: every built file no item claims any more (channel switched off,
  // promoted, item removed). Only for the packages being built.
  const expected = new Set();
  for (const it of doc.items.filter((i) => packages.includes(i.package))) {
    for (const d of destsOf(it)) expected.add(d.toLowerCase());
    if (it.package === 'melee' && catalog.isMap(it.source) && catalog.channelsOf(it).length) expected.add(thumbPathOf(it).toLowerCase());
  }
  const pruned = [];
  for (const pkg of packages) {
    for (const dir of Object.values(OUTPUT_DIRS[pkg])) {
      for (const f of walkFiles(dir)) {
        if (!BUILT_EXT.test(f) || expected.has(f.toLowerCase())) continue;
        pruned.push(f);
        if (!dryRun) fs.rmSync(f, { force: true });
        log(`${dryRun ? 'Would remove' : 'Removed'} ${path.relative(path.dirname(dir), f)} (no longer in the catalog)`);
      }
    }
  }
  if (!dryRun) mpq.cleanTemp();
  return { results, pruned };
}

// Records the current payload files as built from the current sources, so a
// freshly created catalog doesn't repackage 1 GB of unchanged archives.
async function adoptExisting(doc, sc2Root, log = () => {}) {
  const state = loadState();
  const { rows } = catalog.classify(doc, sc2Root);
  const byKey = new Map(rows.map((r) => [catalog.keyOf(r.source), r]));
  let adopted = 0;
  for (const item of doc.items) {
    const row = byKey.get(catalog.keyOf(item.source));
    const dests = destsOf(item);
    if (!row || !row.abs || !dests.length || !fs.existsSync(dests[0])) continue;
    if (state[catalog.keyOf(item.source)]) continue;
    const { hash, size } = await hashOf(dests[0]);
    state[catalog.keyOf(item.source)] = { fingerprint: fingerprint(row.abs), hash, size };
    adopted++;
  }
  saveState(state);
  log(`Adopted ${adopted} existing built file(s) as up to date`);
  return adopted;
}

// Per-item build status for the UI: "built", "changed" (source edited since the
// last build), "unbuilt" (switched on but never built), or "off".
function statusOf(doc, rows) {
  const state = loadState();
  const out = new Map();
  for (const r of rows) {
    if (!r.item) continue;
    const dests = destsOf(r.item);
    if (!dests.length) { out.set(catalog.keyOf(r.source), 'off'); continue; }
    const prev = state[catalog.keyOf(r.source)];
    if (!prev || !dests.every((d) => sameFile(d, prev.size))) { out.set(catalog.keyOf(r.source), 'unbuilt'); continue; }
    let fp = null;
    try { fp = r.abs ? fingerprint(r.abs) : null; } catch {}
    out.set(catalog.keyOf(r.source), fp === prev.fingerprint ? 'built' : 'changed');
  }
  return out;
}

module.exports = { build, adoptExisting, statusOf, destsOf, thumbPathOf, fingerprint, loadState, STATE_FILE };

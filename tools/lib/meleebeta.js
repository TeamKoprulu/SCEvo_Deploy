'use strict';
// The Melee vs AI closed beta: its own branch of mods, code-locked like the campaign beta.
//
// Mods are tagged for the beta in the catalog ("meleeBeta": true), from the same source
// folders as the normal Evo mods. The tag is independent of the item's own package and
// channel, so tagging Core never takes it out of the campaign.
//
// "Build melee beta" packages each tagged mod into betameleepayload/ under
// "Mods/SC Evolution Complete Beta/", the folder the launcher installs them to. Each
// copy's dependencies on other tagged mods are rewritten to that folder (file-only), so a
// beta Multi loads the beta Core while the campaign keeps loading the public one.
// melee-beta-manifest.json lists them, with the beta's name, code hash and colour.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, OUTPUT_DIRS, MELEE_BETA_MANIFEST, MPQ_EDITOR, SCHEMA_VERSION, writeTextAtomic } = require('./config');
const catalog = require('./catalog');
const mpq = require('./mpq');
const { openArchive } = require('./sc2map/mpq');
const { hashOf } = require('./hashcache');

const MOD_DIR = 'Mods\\SC Evolution Complete';
const BETA_MOD_DIR = 'Mods\\SC Evolution Complete Beta';
const STATE_PREFIX = 'meleebeta|';

const isTagged = (item) => !!item?.meleeBeta;
const modName = (source) => path.basename(String(source).replace(/\\/g, '/'), path.extname(String(source)));

// Only mods straight under "Mods\SC Evolution Complete" can be branched: that's the folder the
// launcher's stand-in and the mods' own dependencies point at.
function canTag(source) {
  const s = String(source).replace(/\//g, '\\');
  return /\.sc2mod$/i.test(s) && path.win32.dirname(s).toLowerCase() === MOD_DIR.toLowerCase();
}

// Manifest path (and path inside betameleepayload/) of a tagged mod.
const targetOf = (item) => `Mods/SC Evolution Complete Beta/${path.win32.basename(String(item.source).replace(/\//g, '\\'))}`;
const destOf = (item) => path.join(OUTPUT_DIRS.meleebeta.beta, ...targetOf(item).split('/'));

// The branch: lower-cased names of every tagged mod.
const branchOf = (doc) => new Set(doc.items.filter(isTagged).map((it) => modName(it.source).toLowerCase()));

/* ── dependency rewrite (same rule as the launcher's electron/melee/extensionMods.js) ── */

const DEP_RE = /(?:bnet:[^,<\0\r\n]*,)?file:Mods[\\/]SC Evolution Complete[\\/]([^\\/<\0\r\n]+?)\.SC2Mod/gi;

// Points dependencies on branched mods at the beta folder, file-only (a bnet: half would let the
// game load the published public mod). Text is DocumentInfo, or DocumentHeader read as latin1.
function rewriteDeps(text, branch) {
  if (!branch || !branch.size) return text;
  return text.replace(DEP_RE, (all, name) => (branch.has(name.toLowerCase()) ? `file:${BETA_MOD_DIR}\\${name}.SC2Mod` : all));
}

// The mod names (lower case) a DocumentInfo depends on under "Mods\SC Evolution Complete".
function depsOf(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(DEP_RE)) out.add(m[1].toLowerCase());
  return out;
}

// DocumentInfo and DocumentHeader of a source (folder or packed), as latin1 strings (null when absent).
function readDocFiles(abs) {
  const out = {};
  if (fs.statSync(abs).isDirectory()) {
    for (const n of ['DocumentInfo', 'DocumentHeader']) {
      const f = path.join(abs, n);
      out[n] = fs.existsSync(f) ? fs.readFileSync(f).toString('latin1') : null;
    }
    return out;
  }
  const a = openArchive(abs);
  try {
    for (const n of ['DocumentInfo', 'DocumentHeader']) { const b = a.read(n); out[n] = b ? b.toString('latin1') : null; }
  } finally { if (a.close) a.close(); }
  return out;
}

// Mods the launcher's melee games load (melee mods, and the campaign's core mods such as
// Legacy, Core and Assets) that depend on a tagged mod without being tagged themselves:
// they'd load the public copy of it alongside the beta one. readDocs is injectable for tests.
function closureProblems(doc, rows, readDocs = readDocFiles) {
  const branch = branchOf(doc);
  const problems = [];
  if (!branch.size) return problems;
  const byKey = new Map(rows.map((r) => [catalog.keyOf(r.source), r]));
  for (const it of doc.items) {
    if (isTagged(it) && !canTag(it.source)) problems.push(`${it.source} is tagged for the melee beta, but only mods in "${MOD_DIR}" can be`);
    if (isTagged(it) || !canTag(it.source)) continue;
    const loadedByMelee = it.package === 'melee' || it.module?.type === 'core';
    if (!loadedByMelee) continue;
    const row = byKey.get(catalog.keyOf(it.source));
    if (!row?.abs) continue;
    let deps;
    try { deps = depsOf(readDocs(row.abs).DocumentInfo); } catch { continue; }
    const hit = [...deps].filter((d) => branch.has(d));
    if (hit.length) problems.push(`${modName(it.source)} loads ${hit.join(', ')} by path: tag ${modName(it.source)} for the melee beta too`);
  }
  return problems;
}

/* ── build ── */

// Replaces DocumentInfo / DocumentHeader inside an archive in build-temp with MPQEditor.
// Paths must be relative to REPO_ROOT and space-free (see mpq.js).
async function patchArchive(archiveRel, files, runMpq) {
  const dirRel = path.join('build-temp', '_meleebeta_docs');
  fs.mkdirSync(path.join(REPO_ROOT, dirRel), { recursive: true });
  const lines = [];
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(REPO_ROOT, dirRel, name), Buffer.from(text, 'latin1'));
    lines.push(`delete ${archiveRel} ${name}`, `add ${archiveRel} ${path.join(dirRel, name)} ${name} /c`);
  }
  lines.push(`flush ${archiveRel}`, '');
  const scriptRel = 'MeleeBeta-Docs.mpq2k';
  writeTextAtomic(path.join(REPO_ROOT, scriptRel), lines.join('\r\n'));
  const run = await runMpq(scriptRel);
  try { fs.rmSync(path.join(REPO_ROOT, scriptRel), { force: true }); } catch {}
  fs.rmSync(path.join(REPO_ROOT, dirRel), { recursive: true, force: true });
  return run;
}

/**
 * Builds the melee beta payload. opts: { doc, rows, state, fingerprint, only, force, dryRun, log, runMpq }
 * state: build-state.json (beta entries are kept under "meleebeta|<source>").
 * Returns { results, problems, expected (absolute paths that belong in betameleepayload/) }.
 */
async function buildMeleeBeta({ doc, rows, state, fingerprint, only = null, force = false, dryRun = false, log = () => {}, runMpq }) {
  const results = [];
  const expected = new Set();
  const tagged = doc.items.filter(isTagged);
  for (const it of tagged) expected.add(destOf(it).toLowerCase());
  const problems = closureProblems(doc, rows);
  if (problems.length) { problems.forEach((p) => log(`PROBLEM: ${p}`)); return { results, problems, expected }; }

  const branch = branchOf(doc);
  const branchSig = [...branch].sort().join(',');
  const byKey = new Map(rows.map((r) => [catalog.keyOf(r.source), r]));
  const onlyKeys = only ? new Set(only.map(catalog.keyOf)) : null;

  for (const item of tagged.filter((it) => !onlyKeys || onlyKeys.has(catalog.keyOf(it.source)))) {
    const name = path.win32.basename(String(item.source).replace(/\//g, '\\'));
    const row = byKey.get(catalog.keyOf(item.source));
    if (!row?.abs) { results.push({ source: item.source, ok: false, action: 'missing', error: 'source not found in the SC2 install' }); continue; }
    const dest = destOf(item);
    const key = STATE_PREFIX + catalog.keyOf(item.source);
    try {
      const fp = fingerprint(row.abs);
      const prev = state[key];
      let size = -1;
      try { size = fs.statSync(dest).size; } catch {}
      if (!force && prev && prev.fingerprint === fp && prev.branch === branchSig && prev.size === size) {
        results.push({ source: item.source, ok: true, action: 'up-to-date' });
        continue;
      }
      if (dryRun) { results.push({ source: item.source, ok: true, action: 'would-build' }); continue; }
      if (!fs.existsSync(MPQ_EDITOR)) throw new Error(`MPQEditor.exe not found at ${MPQ_EDITOR}`);

      // 1. The archive as the public build makes it, in build-temp.
      const safe = `meleebeta_${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
      const archiveRel = path.join('build-temp', safe);
      const archiveAbs = path.join(REPO_ROOT, archiveRel);
      fs.mkdirSync(path.dirname(archiveAbs), { recursive: true });
      if (row.packed) {
        mpq.readMpqHeader(row.abs);
        fs.copyFileSync(row.abs, archiveAbs);
      } else {
        const r = await mpq.buildOne({ relPath: item.source, sourceDir: row.abs }, [archiveAbs]);
        if (!r.ok) throw new Error(r.error);
      }

      // 2. Dependencies on branched mods point at the beta folder.
      const docs = readDocFiles(row.abs);
      const patched = {};
      for (const [n, text] of Object.entries(docs)) {
        if (text == null) continue;
        const next = rewriteDeps(text, branch);
        if (next !== text) patched[n] = next;
      }
      if (Object.keys(patched).length) {
        const run = await patchArchive(archiveRel, patched, runMpq);
        const check = readDocFiles(archiveAbs);
        for (const [n, text] of Object.entries(patched)) {
          if (check[n] !== text) throw new Error(`${n} was not updated inside the archive (MPQEditor exit ${run?.code ?? '?'})`);
        }
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(archiveAbs, dest);
      fs.rmSync(archiveAbs, { force: true });
      const { hash, size: built } = await hashOf(dest);
      state[key] = { fingerprint: fp, branch: branchSig, hash, size: built };
      log(`Built ${name} for the melee beta${Object.keys(patched).length ? ' (dependencies → beta folder)' : ''}`);
      results.push({ source: item.source, ok: true, action: 'packaged' });
    } catch (err) {
      log(`FAILED ${name} (melee beta): ${err.message}`);
      results.push({ source: item.source, ok: false, action: 'error', error: err.message });
    }
  }
  return { results, problems, expected };
}

/* ── manifest ── */

// Name, code hash, version, colour and on/off are carried over from the current manifest
// unless overrides set them (overrides.code is the plain code; only its hash is written).
function readCurrent() {
  try { return JSON.parse(fs.readFileSync(MELEE_BETA_MANIFEST, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

async function meleeBetaDoc(doc, overrides = {}, problems = []) {
  const mf = require('./manifest');
  const cur = readCurrent() || {};
  const enabled = 'enabled' in overrides ? !!overrides.enabled : !!cur.betaEnabled;
  const codeHash = overrides.code ? mf.betaCodeHash(overrides.code) : String(overrides.codeHash ?? cur.codeHash ?? '');
  const accent = mf.normalizeHex('accentColor' in overrides ? overrides.accentColor : cur.theme?.accentColor) || '#ff6600';
  const out = {
    schemaVersion: SCHEMA_VERSION,
    lastUpdated: mf.nowIso(),
    betaEnabled: enabled,
    betaName: String(overrides.name ?? cur.betaName ?? ''),
    version: String(overrides.version ?? cur.version ?? ''),
    codeHash,
    theme: mf.themeFromAccent(accent, { badgeText: 'BETA' }),
  };
  // Like the campaign beta: a disabled beta publishes no modules, so nothing can be installed.
  if (!enabled) return out;
  if (!codeHash) problems.push('The melee beta is on but has no code: set one on the Manifest tab');
  const tagged = doc.items.filter(isTagged);
  if (!tagged.length) problems.push('The melee beta is on but no mod is tagged for it');
  const modules = [];
  for (const it of tagged) {
    const abs = destOf(it);
    if (!fs.existsSync(abs)) { problems.push(`${it.source} is tagged for the melee beta but isn't built: run Build melee beta`); continue; }
    const { hash, size } = await hashOf(abs);
    const target = targetOf(it);
    modules.push({ id: `beta-${mf.moduleIdFor(path.basename(target))}`, name: modName(it.source), description: `${modName(it.source)} (melee beta)`,
      files: [{ name: path.basename(target), path: target, size, hash }] });
  }
  out.modules = modules;
  return out;
}

module.exports = {
  MOD_DIR, BETA_MOD_DIR, STATE_PREFIX, isTagged, canTag, targetOf, destOf, branchOf,
  rewriteDeps, depsOf, readDocFiles, closureProblems, buildMeleeBeta, meleeBetaDoc,
};

'use strict';
// Missing models and textures in the Evo dev mods, MP maps and campaign mods. Read-only.
//
// Two kinds of reference are followed:
//   game data -> model / texture   CModel entries, resolved through their parent templates
//                                  (VariationCount gives _00, _01, …), and every other quoted
//                                  .m3 / .dds / .tga path in a GameData XML
//   model -> texture               the CHAR strings of each .m3
// A file can come from vanilla SC2 (the CascView extraction: core + liberty), any Evo mod
// (SCEvo_Assets, SCEvo_CampaignAssets, …) or, for a map, the map itself.
//
// "New" = changed since the repo's last release tag (plus uncommitted work), or pointing at a
// file deleted since then. Older problems are counted separately.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ASSET_REF = /\.(m3|dds|tga)$/i;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// Where a file sits inside its mod or map, the way game paths name it:
// "Base.SC2Assets/Assets/Textures/X.dds" -> "assets/textures/x.dds".
function assetKey(rel) {
  return rel.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase().replace(/^(base|[a-z]{4})\.sc2assets\//, '');
}

// A path as written in an .m3 or in game data -> the same form as assetKey. Absolute paths
// (an artist's "F:\Modding\…") can't resolve: null.
function refKey(ref) {
  const k = ref.trim().replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
  return /^[a-z]:\//.test(k) ? null : k;
}

function indexFiles(root) {
  const out = new Map();
  for (const f of walk(root)) {
    const k = assetKey(path.relative(root, f));
    if (!out.has(k)) out.set(k, f);
  }
  return out;
}

// The texture paths an .m3 names. MD34 files are read through their tag index (CHAR entries);
// anything else falls back to scanning for null-terminated strings.
function m3Textures(buf) {
  const out = new Set();
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === '43DM') {
    const off = buf.readUInt32LE(4), n = buf.readUInt32LE(8);
    for (let i = 0; i < n && off + i * 16 + 16 <= buf.length; i++) {
      const e = off + i * 16;
      if (buf.toString('latin1', e, e + 4) !== 'RAHC') continue;
      const at = buf.readUInt32LE(e + 4), len = buf.readUInt32LE(e + 8);
      const s = buf.toString('latin1', at, Math.min(at + len, buf.length)).replace(/\0+$/, '');
      if (/\.(dds|tga)$/i.test(s)) out.add(s);
    }
    return [...out];
  }
  for (const m of buf.toString('latin1').matchAll(/(?<=\0)[\x20-\x7e]{3,}?\.(dds|tga)(?=\0)/gi)) out.add(m[0]);
  return [...out];
}

const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

// CModel entries of one game data file: { id, parent, model, variations, tokens }.
// Tokens come from <?token?> lines and from attributes such as Race="Terran".
function parseModels(xml) {
  const out = [];
  for (const m of xml.matchAll(/<CModel\b([^>]*?)(?:\/>|>([\s\S]*?)<\/CModel>)/g)) {
    const a = attrsOf(m[1]);
    if (!a.id || a.removed === '1') continue;
    const body = m[2] || '';
    const tokens = {};
    for (const [k, v] of Object.entries(a)) if (!['id', 'parent', 'default'].includes(k)) tokens[k] = v;
    for (const t of body.matchAll(/<\?token\s+([^?]*)\?>/g)) { const ta = attrsOf(t[1]); if (ta.id) tokens[ta.id] = ta.value ?? ''; }
    const rec = { id: a.id, tokens };
    if (a.parent) rec.parent = a.parent;
    const model = /<Model\b[^>]*\bvalue="([^"]*)"/.exec(body);
    if (model) rec.model = model[1];
    const vars = /<VariationCount\b[^>]*\bvalue="(\d+)"/.exec(body);
    if (vars) rec.variations = +vars[1];
    out.push(rec);
  }
  return out;
}

// Quoted asset paths outside CModel entries (those are resolved through their templates,
// where a variation model's own path doesn't exist as a file).
function literalRefs(xml) {
  const text = xml.replace(/<CModel\b[^>]*?(?:\/>|>[\s\S]*?<\/CModel>)/g, '');
  return [...new Set([...text.matchAll(/"([^"<>]+?\.(?:m3|dds|tga))"/gi)].map((m) => m[1]).filter((r) => !r.includes('##')))];
}

// id -> [records], oldest first; later records override earlier ones field by field.
function addModels(catalog, recs) {
  for (const r of recs) { if (!catalog.has(r.id)) catalog.set(r.id, []); catalog.get(r.id).push(r); }
}
function merged(recs) {
  const out = { tokens: {} };
  for (const r of recs) {
    for (const k of ['parent', 'model', 'variations']) if (r[k] !== undefined) out[k] = r[k];
    Object.assign(out.tokens, r.tokens);
  }
  return out;
}

// The files a CModel id loads: [path] or [path_00, path_01, …]. null when the template
// chain gives no model or leaves a token unresolved.
function resolveModel(id, lookup) {
  const tokens = {};
  let template = null, variations, cur = id;
  for (const seen = new Set(); cur && !seen.has(cur); cur = merged(lookup(cur)).parent) {
    seen.add(cur);
    const recs = lookup(cur);
    if (!recs.length) break;
    const m = merged(recs);
    for (const [k, v] of Object.entries(m.tokens)) if (!(k in tokens)) tokens[k] = v;
    if (variations === undefined && m.variations !== undefined) variations = m.variations;
    if (template === null && m.model) template = m.model;
  }
  if (!template) return null;
  const p = template.replace(/##(\w+)##/g, (_, t) => (t === 'id' ? id : tokens[t] ?? `##${t}##`));
  if (p.includes('##') || !p.trim()) return null;
  if (!variations || variations < 2) return [p];
  return Array.from({ length: variations }, (_, i) => p.replace(/\.m3$/i, `_${String(i).padStart(2, '0')}.m3`));
}

/* ── git: what changed since the last release ─────────────────────────────── */

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

// { tag, changed: Set, deleted: Set, old(rel) } with repo-relative posix paths, lowercased.
// tag null: not a git repo or no tag, and everything counts as new.
function changesSince(repo, tagPattern) {
  const tags = git(repo, ['tag', '--list', ...(tagPattern ? [tagPattern] : []), '--sort=-creatordate']);
  const tag = tags ? tags.split(/\r?\n/).find(Boolean) || null : null;
  if (!tag) return { tag: null, changed: null, deleted: new Set(), old: () => null };
  const changed = new Set(), deleted = new Set();
  const diff = git(repo, ['diff', '--name-status', '--no-renames', '-z', tag]) || '';
  const parts = diff.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) (parts[i] === 'D' ? deleted : changed).add(parts[i + 1].toLowerCase());
  for (const f of (git(repo, ['ls-files', '--others', '--exclude-standard', '-z']) || '').split('\0').filter(Boolean)) changed.add(f.toLowerCase());
  const cache = new Map();
  const old = (rel) => {
    if (!cache.has(rel)) cache.set(rel, git(repo, ['show', `${tag}:${rel}`]));
    return cache.get(rel);
  };
  return { tag, changed, deleted, old };
}

/* ── containers ───────────────────────────────────────────────────────────── */

// Folders named *<ext> up to `depth` levels down (not inside one another).
function findDirs(root, ext, depth = 4, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    if (e.name.toLowerCase().endsWith(ext)) out.push(p); else if (depth > 1) findDirs(p, ext, depth - 1, out);
  }
  return out;
}

// Folder-form mods and maps: { name, root, repo, kind }.
function containersOf({ devRoot, campaignRoot }) {
  const out = [];
  const evo = devRoot && path.join(devRoot, 'SC Evo Complete');
  if (evo && fs.existsSync(evo)) {
    for (const d of fs.readdirSync(evo, { withFileTypes: true })) {
      if (d.isDirectory() && /\.sc2mod$/i.test(d.name)) out.push({ name: d.name, root: path.join(evo, d.name), repo: 'dev', kind: 'mod' });
    }
    for (const m of findDirs(path.join(evo, 'MP Maps'), '.sc2map')) out.push({ name: path.relative(evo, m).replace(/\\/g, '/'), root: m, repo: 'dev', kind: 'map' });
  }
  const camp = campaignRoot && path.join(campaignRoot, 'SCEvo_CampaignMods');
  if (camp && fs.existsSync(camp)) {
    for (const d of fs.readdirSync(camp, { withFileTypes: true })) {
      if (d.isDirectory() && /\.sc2mod$/i.test(d.name)) out.push({ name: d.name, root: path.join(camp, d.name), repo: 'campaign', kind: 'mod' });
    }
  }
  return out;
}

const VANILLA_DATA = ['core', 'liberty', 'swarm', 'void'];

/**
 * opts: { devRoot, campaignRoot, cascRoot, gameDataPath, all }
 *   cascRoot: the CascView SC2 folder (holding mods\liberty.sc2mod); all: every problem counts as new.
 * Returns { problems: [{ kind, level, container, from, ref, byName, absolute, isNew, deleted }], stats, since, warnings }.
 * kind: 'model' | 'texture'; level: 'error' | 'warn'. byName: the path doesn't exist but a texture
 * with that file name does. absolute: a drive-letter path (exported without MoPaQ paths).
 * deleted: the file was deleted since the release tag.
 */
function modelCheck({ devRoot, campaignRoot, cascRoot, gameDataPath, all = false, devTagPattern = 'Update-*' }) {
  const warnings = [];
  const t0 = Date.now();

  // Vanilla files: every mod or campaign extracted under the CascView SC2 folder (core and
  // liberty hold nearly all models and textures; extract more to cover campaign / coop UI art).
  const vanilla = new Map();
  const extracted = cascRoot ? [...findDirs(cascRoot, '.sc2mod'), ...findDirs(cascRoot, '.sc2campaign')] : [];
  for (const dir of extracted) for (const [k, f] of indexFiles(dir)) if (!vanilla.has(k)) vanilla.set(k, f);
  if (!extracted.some((d) => /^liberty\.sc2mod$/i.test(path.basename(d)))) warnings.push(`no liberty.sc2mod extraction under ${cascRoot || '(CascView path not set)'}`);
  const baseCatalog = new Map();
  for (const mod of VANILLA_DATA) {
    const f = gameDataPath && path.join(gameDataPath, 'mods', `${mod}.sc2mod`, 'base.sc2data', 'GameData', 'ModelData.xml');
    if (f && fs.existsSync(f)) addModels(baseCatalog, parseModels(fs.readFileSync(f, 'utf8')));
    else warnings.push(`vanilla ModelData not found: ${f || '(no SC2GameData path)'}`);
  }

  // Evo mods and maps.
  const repos = { dev: devRoot, campaign: campaignRoot };
  const repoGit = {
    dev: all || !devRoot ? null : changesSince(devRoot, devTagPattern),
    campaign: all || !campaignRoot ? null : changesSince(campaignRoot, null),
  };
  const containers = containersOf({ devRoot, campaignRoot });
  for (const c of containers) {
    c.files = indexFiles(c.root);
    c.repoRel = (rel) => path.relative(repos[c.repo], path.join(c.root, rel)).replace(/\\/g, '/');
  }
  const shared = new Map();
  for (const c of containers.filter((x) => x.kind === 'mod')) for (const [k, f] of c.files) if (!shared.has(k)) shared.set(k, f);
  const textureNames = new Set();
  for (const pool of [vanilla, shared, ...containers.filter((x) => x.kind === 'map').map((x) => x.files)]) {
    for (const k of pool.keys()) if (/\.(dds|tga)$/.test(k)) textureNames.add(path.posix.basename(k));
  }

  // Game data of every Evo mod goes into one catalog over vanilla; a map's own entries sit on top.
  const dataFiles = (c) => [...c.files.entries()].filter(([k]) => /^base\.sc2data\/gamedata\/.+\.xml$/.test(k));
  for (const c of containers) {
    c.data = dataFiles(c).map(([k, f]) => ({ key: k, rel: path.relative(c.root, f).replace(/\\/g, '/'), xml: fs.readFileSync(f, 'utf8') }));
    c.models = c.data.flatMap((d) => parseModels(d.xml).map((r) => ({ ...r, file: d })));
  }
  const evoCatalog = new Map(baseCatalog);
  for (const [id, recs] of baseCatalog) evoCatalog.set(id, [...recs]);
  for (const c of containers.filter((x) => x.kind === 'mod')) addModels(evoCatalog, c.models);

  const state = (c) => repoGit[c.repo];
  const isChanged = (c, rel) => { const g = state(c); return !g || !g.changed || g.changed.has(c.repoRel(rel).toLowerCase()); };
  const deletedKeys = new Set();
  for (const c of containers) {
    const g = state(c);
    if (!g) continue;
    const prefix = `${path.relative(repos[c.repo], c.root).replace(/\\/g, '/').toLowerCase()}/`;
    for (const d of g.deleted) if (d.startsWith(prefix)) deletedKeys.add(assetKey(d.slice(prefix.length)));
  }

  const refs = [];   // { kind, c, from, ref, isNew }
  const add = (r) => refs.push(r);

  for (const c of containers) {
    const lookup = c.kind === 'map'
      ? (() => { const own = new Map(); addModels(own, c.models); return (id) => [...(evoCatalog.get(id) || []), ...(own.get(id) || [])]; })()
      : (id) => evoCatalog.get(id) || [];

    // Game data: CModel entries this mod or map defines or changes.
    const oldModels = new Map();
    for (const r of c.models) {
      let isNew = isChanged(c, r.file.rel);
      if (isNew && state(c)?.changed) {
        if (!oldModels.has(r.file.rel)) oldModels.set(r.file.rel, parseModels(state(c).old(c.repoRel(r.file.rel)) || ''));
        const sig = (x) => JSON.stringify([x.parent, x.model, x.variations, x.tokens]);
        isNew = !oldModels.get(r.file.rel).some((o) => o.id === r.id && sig(o) === sig(r));
      }
      for (const p of resolveModel(r.id, lookup) || []) add({ kind: 'model', c, from: `${r.file.rel}: CModel ${r.id}`, ref: p, isNew });
    }
    // Game data: every other quoted model / texture path.
    for (const d of c.data) {
      const refsNow = literalRefs(d.xml);
      if (!refsNow.length) continue;
      const changed = isChanged(c, d.rel);
      const before = changed && state(c)?.changed ? new Set(literalRefs(state(c).old(c.repoRel(d.rel)) || '')) : null;
      for (const ref of refsNow) add({ kind: /\.m3$/i.test(ref) ? 'model' : 'texture', c, from: d.rel, ref, isNew: changed && !(before && before.has(ref)) });
    }
    // Models: their textures.
    for (const [k, f] of c.files) {
      if (!k.endsWith('.m3')) continue;
      const rel = path.relative(c.root, f).replace(/\\/g, '/');
      let buf;
      try { buf = fs.readFileSync(f); } catch { continue; }
      for (const t of m3Textures(buf)) add({ kind: 'texture', c, from: rel, ref: t, isNew: isChanged(c, rel) });
    }
  }

  // Resolve.
  const problems = [];
  const seen = new Set();
  let checked = 0;
  for (const r of refs) {
    const k = refKey(r.ref);
    const dedupe = `${r.c.name}|${r.from}|${k ?? r.ref}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    checked++;
    if (k && (r.c.files.has(k) || shared.has(k) || vanilla.has(k))) continue;
    const name = path.posix.basename((k ?? r.ref.replace(/\\/g, '/')).toLowerCase());
    const deleted = !!k && deletedKeys.has(k);
    // A drive-letter path ("F:\Modding\…\X.dds"): the model was exported without MoPaQ paths
    // and has to be re-exported; it never loads, whatever is on disk.
    const absolute = !k;
    if (absolute) { problems.push({ kind: r.kind, level: 'error', container: r.c.name, from: r.from, ref: r.ref, byName: false, absolute, isNew: r.isNew, deleted: false }); continue; }
    const byName = r.kind === 'texture' && textureNames.has(name);
    // error: certainly broken. warn: a wrong path whose file name exists, or a game data texture
    // that may be vanilla art outside the extraction (campaign / coop UI).
    const fromData = /\.xml$/i.test(r.from);
    const level = deleted || (!byName && (r.kind === 'model' || !fromData)) ? 'error' : 'warn';
    problems.push({ kind: r.kind, level, container: r.c.name, from: r.from, ref: r.ref, byName, absolute, isNew: r.isNew || deleted, deleted });
  }

  return {
    problems,
    since: { dev: repoGit.dev?.tag ?? null, campaign: repoGit.campaign?.tag ?? null },
    stats: { containers: containers.length, references: checked, vanillaFiles: vanilla.size, ms: Date.now() - t0 },
    warnings,
  };
}

module.exports = { modelCheck, m3Textures, parseModels, literalRefs, resolveModel, assetKey, refKey, addModels, containersOf };

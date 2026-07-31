'use strict';
// Manifest load / merge / order-stable serialise.
//
// Fixes vs build-manifests.ps1:
//   B3 - criticalUpdate is carried forward from the existing manifest instead of
//        defaulting to disabled and silently wiping production.
//   B4 - downloadUrl/downloadUrls are preserved when present but NEVER invented.
//        The old script defaulted them to a dead GitHub Releases URL that Enter
//        accepted, and the launcher genuinely prefers them (main.js:729-735).
//   B6 - existing module order is preserved; new modules append at the end.

const fs = require('node:fs');
const path = require('node:path');
const { stripJunk, writeTextAtomic, SCHEMA_VERSION } = require('./config');

function readManifest(file) {
  try {
    return JSON.parse(stripJunk(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${path.basename(file)}: ${err.message}`);
  }
}

// Backs up to .bak.json then writes deterministic 2-space JSON, UTF-8 no BOM.
function writeManifest(file, obj) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, file.replace(/\.json$/i, '.bak.json'));
  }
  writeTextAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

// "SCEvo_Assets.SC2Mod" -> "scevo-assets"   (build-manifests.ps1:104-107)
function moduleIdFor(filename) {
  return path.basename(filename, path.extname(filename)).toLowerCase().replace(/_/g, '-');
}

// Payload-relative disk path -> SC2-install-relative manifest path.
// Forward slashes, and the first segment forced to Maps/ or Mods/ so casing is
// stable regardless of how the folder is spelled on disk.
// (build-manifests.ps1:270-277)
function normalizeManifestPath(relFromPayloadRoot) {
  let rel = String(relFromPayloadRoot).replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^mods\//i.test(rel)) rel = 'Mods' + rel.slice(4);
  if (/^maps\//i.test(rel)) rel = 'Maps' + rel.slice(4);
  return rel;
}

// path -> { moduleIndex, fileIndex, module, file } for every file in a manifest.
function indexByPath(manifest) {
  const idx = new Map();
  const mods = Array.isArray(manifest?.modules) ? manifest.modules : [];
  mods.forEach((module, moduleIndex) => {
    const files = Array.isArray(module.files) ? module.files : [];
    files.forEach((file, fileIndex) => {
      if (file?.path) idx.set(file.path, { moduleIndex, fileIndex, module, file });
    });
  });
  return idx;
}

const DEFAULT_CRITICAL = { enabled: false, minVersion: '', message: '', severity: 'critical' };

// Carries the existing block forward verbatim, filling only absent keys.
function mergeCritical(existing, isBeta) {
  const base = { ...DEFAULT_CRITICAL, ...(existing && typeof existing === 'object' ? existing : {}) };
  const out = {
    enabled:    !!base.enabled,
    minVersion: String(base.minVersion ?? ''),
    message:    String(base.message ?? ''),
  };
  // Production's beta manifest has no `severity`; the public one does. Keep the
  // shapes distinct rather than "fixing" one to match the other.
  if (!isBeta) out.severity = String(base.severity || 'critical');
  return out;
}

// Builds the editable working set the UI renders: existing modules in their
// existing order, annotated with what changed on disk, plus new files appended.
function buildWorkingSet({ existing, scanned }) {
  const byPath = indexByPath(existing);
  const scannedByPath = new Map(scanned.map((f) => [f.path, f]));
  const seen = new Set();
  const modules = [];

  // 1. Existing modules, in their original order.
  for (const module of (existing?.modules ?? [])) {
    const files = (Array.isArray(module.files) ? module.files : []).map((file) => {
      const hit = scannedByPath.get(file.path);
      if (hit) seen.add(file.path);
      const entry = {
        name: file.name ?? path.basename(file.path ?? ''),
        path: file.path,
        size: hit ? hit.size : file.size,
        hash: hit ? hit.hash : file.hash,
        manifestSize: file.size,
        manifestHash: file.hash,
        onDisk: !!hit,
        state: !hit ? 'missing'
             : (hit.hash !== file.hash) ? 'changed'
             : 'unchanged',
      };
      // Preserved only if already present. Never invented (B4).
      if (Array.isArray(file.downloadUrls) && file.downloadUrls.length) entry.downloadUrls = [...file.downloadUrls];
      else if (file.downloadUrl) entry.downloadUrl = String(file.downloadUrl);
      return entry;
    });
    modules.push({
      id: module.id ?? '',
      name: module.name ?? '',
      description: module.description ?? '',
      type: module.type ?? '',
      files,
      state: files.some((f) => f.state === 'missing') ? 'missing'
           : files.some((f) => f.state === 'changed') ? 'changed'
           : 'unchanged',
    });
  }

  // 2. Files on disk that no manifest module claims — appended, never inserted.
  for (const f of scanned) {
    if (seen.has(f.path)) continue;
    modules.push({
      id: moduleIdFor(f.name),
      name: path.basename(f.name, path.extname(f.name)),
      description: path.basename(f.name, path.extname(f.name)),
      type: '',
      files: [{
        name: f.name, path: f.path, size: f.size, hash: f.hash,
        manifestSize: null, manifestHash: null, onDisk: true, state: 'new',
      }],
      state: 'new',
    });
  }

  return modules;
}

// Serialises a module working set back to the on-wire shape.
// Drops UI-only annotations; omits `type` when blank, matching the old output.
function serializeModules(modules) {
  return modules.map((m) => {
    const out = { id: m.id, name: m.name, description: m.description };
    if (m.type) out.type = m.type;
    out.files = m.files.map((f) => {
      const file = { name: f.name, path: f.path, size: f.size, hash: f.hash };
      if (Array.isArray(f.downloadUrls) && f.downloadUrls.length) file.downloadUrls = f.downloadUrls;
      else if (f.downloadUrl) file.downloadUrl = f.downloadUrl;
      return file;
    });
    return out;
  });
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildPublicManifest({ versions, criticalUpdate, modules }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    lastUpdated: nowIso(),
    versions: {
      multiplayer: String(versions?.multiplayer ?? ''),
      campaign:    String(versions?.campaign ?? ''),
    },
    criticalUpdate: mergeCritical(criticalUpdate, false),
    modules: serializeModules(modules),
  };
}

function buildBetaManifest({ meta, criticalUpdate, modules, coreVersion }) {
  const accent = String(meta?.accentColor || '#ff6600');
  const out = {
    schemaVersion: SCHEMA_VERSION,
    lastUpdated: nowIso(),
    betaEnabled: !!meta?.betaEnabled,
    betaName: String(meta?.betaName ?? ''),
    majorVersion: String(meta?.majorVersion ?? ''),
    fullVersion: String(meta?.fullVersion ?? ''),
    codeHash: String(meta?.codeHash ?? ''),
    theme: {
      accentColor: accent,
      accentColorDim: accent + '44',
      particleColor: hexToRgbString(accent),
      bgGlow: accent + '15',
      badgeText: 'BETA',
      badgeColor: accent,
    },
  };
  // When the beta is off, production serves the stripped shape (no modules, no
  // criticalUpdate, no versions). The old script could only ever write
  // betaEnabled:true, so that shape had to be hand-edited.
  if (out.betaEnabled) {
    out.criticalUpdate = mergeCritical(criticalUpdate, true);
    out.modules = serializeModules(modules);
    if (coreVersion) out.versions = { multiplayer: String(coreVersion) };
  }
  return out;
}

// "#ff6600" -> "255, 102, 0"   (build-manifests.ps1:95-101)
function hexToRgbString(hex) {
  const h = String(hex).replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return '255, 102, 0';
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
}

// SHA-256 of the UPPERCASED plaintext, lowercase hex.
// Must match sc-evo-launcher/electron/main.js:458 exactly.
function betaCodeHash(plaintext) {
  return require('node:crypto')
    .createHash('sha256')
    .update(String(plaintext).trim().toUpperCase())
    .digest('hex');
}

// Segment-wise numeric comparison, matching the launcher's compareVersions
// (main.js:1139-1141). Lexicographic compare gets "1.20" vs "1.9" wrong.
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

module.exports = {
  readManifest, writeManifest, moduleIdFor, normalizeManifestPath, indexByPath,
  buildWorkingSet, serializeModules, buildPublicManifest, buildBetaManifest,
  mergeCritical, hexToRgbString, betaCodeHash, compareVersions, nowIso,
};

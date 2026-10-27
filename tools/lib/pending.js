'use strict';
// Which packages have changes that aren't on the CDN yet: each local manifest against the live one
// (ignoring lastUpdated), with a short human summary of what differs.

const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');

const PACKAGE_FILES = {
  campaign: ['update-manifest.json', 'beta-manifest.json', 'news-feed.json'],
  melee: ['melee-manifest.json'],
  meleebeta: ['melee-beta-manifest.json'],
};

// The launcher that a deploy would publish (the launcher repo's version and exes), against the live
// launcher-version.json. The local launcher-version.json is only rewritten while deploying, so it can't tell.
async function launcherPending({ r2 = require('./r2') } = {}) {
  const live = await r2.publishedLauncherVersion();
  const staged = await r2.stageLauncherArtifacts({ dryRun: true, published: live });
  if (staged.warnings.some((w) => /not configured|invalid/.test(w))) return { changed: false, details: ['launcher repo not set (Settings)'] };
  const next = await r2.writeLauncherVersion({ dryRun: true, published: live, files: staged.files });
  if (!next.ok) return { changed: false, details: [next.error] };
  const v = next.doc.version, was = live?.version ?? null;
  if (v !== was) return { changed: true, details: [`launcher ${was ?? '—'} → ${v}`] };
  // Same version, but the address launchers download from (and learn) is changing.
  const host = (u) => { try { return new URL(u).origin; } catch { return null; } };
  const liveBase = live?.cdnBase ?? host(live?.portable?.url);
  if (next.doc.cdnBase && liveBase !== next.doc.cdnBase) return { changed: true, details: [`CDN address → ${next.doc.cdnBase}`] };
  // The Windows 7 build can change on its own (first release, or a rebuild at this version).
  const w7Live = live?.win7 ?? null, w7Next = next.doc.win7 ?? null;
  if (w7Next && (w7Next.version !== w7Live?.version || w7Next.portable?.sha256 !== w7Live?.portable?.sha256)) {
    return { changed: true, details: [`Windows 7 launcher ${w7Live?.version ?? '—'} → ${w7Next.version}`] };
  }
  const exeDiffers = live?.portable?.sha256 ? live.portable.sha256 !== next.doc.portable.sha256 : staged.staged.length > 0;
  if (exeDiffers) return { changed: true, warn: true, details: [`exe rebuilt but still ${v}: bump the version or players won't get it`] };
  return { changed: false, details: [] };
}

// Files in assets/ (replay icons, hero backgrounds, news images) that R2 doesn't have yet, or has
// with other bytes. No manifest lists them, so the folder itself is compared. Summed per subfolder.
async function assetsPending({ diff = require('./r2').diffFolder } = {}) {
  const r = await diff('assets');
  if (!r.ok) return { changed: false, details: [`could not compare: ${r.error}`] };
  const per = (paths) => {
    const n = new Map();
    for (const p of paths) { const top = p.includes('/') ? p.slice(0, p.indexOf('/')) : '(top level)'; n.set(top, (n.get(top) || 0) + 1); }
    return [...n].map(([dir, c]) => `${dir} ${c}`).join(', ');
  };
  const details = [];
  if (r.missing.length) details.push(`${r.missing.length} new (${per(r.missing)})`);
  if (r.differ.length) details.push(`${r.differ.length} changed (${per(r.differ)})`);
  return { changed: details.length > 0, details };
}

const strip = (doc) => { if (!doc || typeof doc !== 'object') return doc; const { lastUpdated, ...rest } = doc; return rest; };
const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

const fileKey = (f) => `${f.path}|${f.hash}`;
const filesOf = (m) => [
  ...(m?.modules || []).flatMap((x) => x.files || []),
  ...(m?.maps || []).flatMap((x) => [x.file, x.thumbnail].filter(Boolean)),
  ...(m?.decals ? [m.decals.list, ...(m.decals.files || [])] : []),
];

// What changed between the live and the local manifest, in a few words.
function describe(name, live, local) {
  if (!live) return [`${name}: not on the CDN yet`];
  const out = [];
  if (local.version && live.version !== local.version) out.push(`version ${live.version ?? '—'} → ${local.version}`);
  if (local.decals && !live.decals) out.push('decals added');
  else if (local.decals && JSON.stringify(local.decals) !== JSON.stringify(live.decals)) out.push('decals changed');
  const liveMaps = new Map((live.maps || []).map((m) => [m.id, m]));
  const mapChanges = (local.maps || []).filter((m) => !liveMaps.has(m.id) || liveMaps.get(m.id).file?.hash !== m.file?.hash).length
    + [...liveMaps.keys()].filter((id) => !(local.maps || []).some((m) => m.id === id)).length;
  if (mapChanges) out.push(`${mapChanges} map${mapChanges === 1 ? '' : 's'} changed`);
  const liveFiles = new Set(filesOf(live).map(fileKey));
  const modChanges = (local.modules || []).flatMap((x) => x.files || []).filter((f) => !liveFiles.has(fileKey(f))).length;
  if (modChanges) out.push(`${modChanges} file${modChanges === 1 ? '' : 's'} changed`);
  if (!out.length) out.push(`${name} changed`);
  return out;
}

/**
 * fetchJson(url) -> { ok, data, error } (verify.fetchJson). Returns
 * { offline, packages: { campaign: { changed, details: [] }, melee: { … }, launcher, assets } }.
 */
async function pendingPackages({ fetchJson = require('./verify').fetchJson, base = cfg.publicBase(), manifestDir = cfg.MANIFEST_DIR, launcher = launcherPending, assets = assetsPending } = {}) {
  const packages = {};
  let offline = false;
  for (const [pkg, names] of Object.entries(PACKAGE_FILES)) {
    const details = [];
    for (const name of names) {
      const file = path.join(manifestDir, name);
      if (!fs.existsSync(file)) continue;
      let local;
      try { local = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { details.push(`${name}: not valid JSON`); continue; }
      const r = await fetchJson(`${base}/manifests/${name}`);
      if (!r.ok && !/^HTTP 404/.test(r.error || '')) { offline = true; continue; }
      const live = r.ok ? r.data : null;
      if (!same(live, local)) details.push(...describe(name, live, local));
    }
    packages[pkg] = { changed: details.length > 0, details };
  }
  try { packages.launcher = await launcher(); } catch (e) { packages.launcher = { changed: false, details: [`could not check: ${e.message}`] }; }
  try { packages.assets = await assets(); } catch (e) { packages.assets = { changed: false, details: [`could not check: ${e.message}`] }; }
  return { offline, packages };
}

module.exports = { pendingPackages, launcherPending, assetsPending, describe, PACKAGE_FILES };

'use strict';
// Melee map metadata for melee-manifest.json, read from the built archive with
// the launcher's own reader (sc2map/), plus the SCEvo mods each map needs.

const fs = require('node:fs');
const path = require('node:path');
const { readMapInfo, openMap } = require('./sc2map/mapInfo');

// "bnet:SCEvo_MultiArtMod_Public/0.0/464472,file:Mods\SC Evolution Complete\SCEvo_MultiArtMod.SC2Mod"
//   -> "Mods/SC Evolution Complete/SCEvo_MultiArtMod.SC2Mod"
// Blizzard's own mods (Mods/Void.SC2Mod, …) ship with the game and are left out.
function depsOf(documentInfoXml) {
  const block = /<Dependencies>([\s\S]*?)<\/Dependencies>/.exec(documentInfoXml || '');
  if (!block) return [];
  const out = [];
  for (const m of block[1].matchAll(/<Value>[^<]*?file:([^<]+)<\/Value>/g)) {
    const p = m[1].trim().replace(/\\/g, '/');
    if (/^Mods\/SC Evolution Complete\//i.test(p)) out.push(p);
  }
  return out;
}

// Reads a mod's DocumentInfo from the SC2 install (folder or packed mod).
function modDeps(sc2Root, modPath) {
  const abs = path.join(sc2Root, ...modPath.split('/'));
  if (!fs.existsSync(abs)) return null;
  const src = openMap(abs);
  try {
    const info = src.read('DocumentInfo');
    return depsOf(info ? info.toString('utf8') : '');
  } finally { src.close(); }
}

// Every SCEvo mod a document needs, following mod-to-mod dependencies.
// `missing` lists mods that couldn't be read from the SC2 install.
function closure(sc2Root, direct) {
  const all = [];
  const missing = [];
  const seen = new Set();
  const visit = (p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    all.push(p);
    const deps = sc2Root ? modDeps(sc2Root, p) : [];
    if (deps === null) { missing.push(p); return; }
    deps.forEach(visit);
  };
  direct.forEach(visit);
  return { mods: all, missing };
}

// archivePath: the built map. sc2Root: the SC2 install, used to follow mod dependencies.
function readMapMeta(archivePath, { sc2Root, thumbnailSize = 256 } = {}) {
  const info = readMapInfo(archivePath, { thumbnailSize });
  const src = openMap(archivePath);
  let direct;
  try {
    const doc = src.read('DocumentInfo');
    direct = depsOf(doc ? doc.toString('utf8') : '');
  } finally { src.close(); }
  const { mods, missing } = closure(sc2Root, direct);
  const thumbnail = info.thumbnail && info.thumbnail.startsWith('data:image/png;base64,')
    ? Buffer.from(info.thumbnail.slice('data:image/png;base64,'.length), 'base64')
    : null;
  return {
    name: info.name,
    description: info.description,
    modes: info.modes,
    players: info.players,
    size: info.size,
    tileset: info.tileset,
    supported: info.supported,
    reason: info.reason,
    requiresMods: mods,
    unreadableMods: missing,
    thumbnail,
  };
}

module.exports = { readMapMeta, depsOf, closure };

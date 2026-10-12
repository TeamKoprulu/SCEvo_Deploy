'use strict';
// Player decals for the melee package: the reward list from the game data, the
// textures from a CASC extraction, packed into one 64px atlas per race plus a list.
//
// Output (meleepayload/decals/):
//   terran.png, terran_bg.png, zerg.png, protoss.png   atlases, 16 tiles per row, same index per race
//   decals.json   { version, tile, cols, races: {race: {atlas, background?}}, decals: [{id, race, name, index, hidden, colored}] }
// The textures stay untinted; the launcher tints them with the player colour.

const fs = require('node:fs');
const path = require('node:path');
const { OUTPUT_DIRS, readConfig } = require('./config');
const { decodeDds, downsample } = require('./img/dds');
const { encodePng } = require('./img/png');

const TILE = 64;
const COLS = 16;
const RACES = { DECALTERRAN: 'terran', DECALZERG: 'zerg', DECALPROTOSS: 'protoss' };
const DEFAULT_PATHS = {
  sc2AssetsPath: 'D:\\Casc Viewer\\SC2\\mods\\liberty.sc2mod\\base.sc2assets\\assets\\textures',
  sc2GameDataPath: 'D:\\SCBW\\SC2GameData',
};
const DECALS_DIR = () => path.join(OUTPUT_DIRS.melee.public, 'decals');

function sourcePaths(cfg = readConfig()) {
  const assets = cfg.sc2AssetsPath || DEFAULT_PATHS.sc2AssetsPath;
  const data = cfg.sc2GameDataPath || DEFAULT_PATHS.sc2GameDataPath;
  return {
    assets,
    rewards: path.join(data, 'mods', 'liberty.sc2mod', 'base.sc2data', 'GameData', 'RewardData.xml'),
    strings: path.join(data, 'mods', 'liberty.sc2mod', 'enus.sc2data', 'LocalizedData', 'GameStrings.txt'),
  };
}

// CRewardDecal entries -> [{ reward, texture, race, hidden }]. A reward without
// <Texture> uses its own id (the ##id## default in core RewardData).
function parseRewards(xml) {
  const out = [];
  const re = /<CRewardDecal\b([^>]*?)(\/>|>([\s\S]*?)<\/CRewardDecal>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if (attrs.default === '1' || !RACES[attrs.parent]) continue;
    const body = m[3] || '';
    const texture = /<Texture value="([^"]+)"/.exec(body)?.[1] || attrs.id;
    const hidden = /<Flags index="Hidden" value="1"/.test(body);
    out.push({ reward: attrs.id, texture, race: RACES[attrs.parent], hidden });
  }
  return out;
}

function parseStrings(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && line.startsWith('Reward/Name/')) map.set(line.slice(12, i), line.slice(i + 1));
  }
  return map;
}

// Pixel stats of a 64px RGBA tile: share of visible pixels, and whether they carry real colour.
function classify(img) {
  let visible = 0, colored = 0;
  for (let p = 0; p < img.data.length; p += 4) {
    if (img.data[p + 3] < 64) continue;
    visible++;
    const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max > 40 && (max - min) / max > 0.25) colored++;
  }
  const total = img.data.length / 4;
  return { blank: visible / total < 0.002, colored: visible > 0 && colored / visible > 0.08 };
}

function loadTile(file) {
  if (!fs.existsSync(file)) return null;
  const img = decodeDds(fs.readFileSync(file));
  return img.width === TILE ? img : downsample(img, TILE);
}

function blit(atlas, tile, index) {
  const ox = (index % COLS) * TILE, oy = Math.floor(index / COLS) * TILE;
  for (let y = 0; y < TILE; y++) {
    const src = y * TILE * 4, dst = ((oy + y) * atlas.width + ox) * 4;
    atlas.data.set(tile.data.subarray(src, src + TILE * 4), dst);
  }
}

const newAtlas = (n) => {
  const width = COLS * TILE, height = Math.max(1, Math.ceil(n / COLS)) * TILE;
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
};

// Writes only when the bytes differ, so unchanged builds keep their hashes and mtimes.
function writeIfChanged(file, buf, dryRun) {
  if (fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), buf) === 0) return false;
  if (!dryRun) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); }
  return true;
}

/**
 * opts: { exclude: [texture ids], dryRun, log, paths (override sourcePaths()) }
 * Returns { files: [abs paths], decals, blank: [ids], missing: [ids], changed: [names] }.
 */
function buildDecals({ exclude = [], dryRun = false, log = () => {}, paths = sourcePaths() } = {}) {
  for (const [k, p] of Object.entries(paths)) if (!fs.existsSync(p)) throw new Error(`Decal source not found (${k}): ${p}`);
  const names = parseStrings(fs.readFileSync(paths.strings, 'utf8'));
  const excluded = new Set(exclude.map((s) => s.toLowerCase()));
  const rewards = parseRewards(fs.readFileSync(paths.rewards, 'utf8'))
    .filter((r) => !excluded.has(r.texture.toLowerCase()))
    .sort((a, b) => a.texture.localeCompare(b.texture));

  const byRace = { terran: [], zerg: [], protoss: [] };
  for (const r of rewards) byRace[r.race].push(r);

  const outDir = DECALS_DIR();
  const decals = [], blank = [], missing = [], changed = [], files = [];
  const races = {};
  for (const [race, list] of Object.entries(byRace)) {
    const atlas = newAtlas(list.length);
    const bg = race === 'terran' ? newAtlas(list.length) : null;
    list.forEach((r, index) => {
      const tile = loadTile(path.join(paths.assets, `${r.texture.toLowerCase()}.dds`));
      if (!tile) { missing.push(r.texture); return; }
      blit(atlas, tile, index);
      if (bg) {
        const plate = loadTile(path.join(paths.assets, `${r.texture.replace(/^Decal_/i, 'Background_').toLowerCase()}.dds`));
        if (plate) blit(bg, plate, index);
      }
      const c = classify(tile);
      if (c.blank) blank.push(r.texture);
      decals.push({
        id: r.texture, race, index, hidden: r.hidden, colored: c.colored,
        name: names.get(r.reward) || names.get(r.texture) || r.texture,
      });
    });
    races[race] = { atlas: `decals/${race}.png`, ...(bg ? { background: `decals/${race}_bg.png` } : {}) };
    for (const [name, img] of [[`${race}.png`, atlas], ...(bg ? [[`${race}_bg.png`, bg]] : [])]) {
      const file = path.join(outDir, name);
      if (writeIfChanged(file, encodePng(img), dryRun)) changed.push(name);
      files.push(file);
    }
  }

  const doc = { version: 1, tile: TILE, cols: COLS, races, decals };
  const listFile = path.join(outDir, 'decals.json');
  if (writeIfChanged(listFile, Buffer.from(JSON.stringify(doc, null, 2) + '\n'), dryRun)) changed.push('decals.json');
  files.push(listFile);

  log(`Decals: ${decals.length} (${Object.entries(byRace).map(([k, v]) => `${k} ${v.length}`).join(', ')})`
    + `${changed.length ? `, ${dryRun ? 'would write' : 'wrote'} ${changed.join(', ')}` : ', unchanged'}`);
  if (missing.length) log(`WARNING: ${missing.length} decal texture(s) not found: ${missing.join(', ')}`);
  if (blank.length) log(`WARNING: ${blank.length} decal(s) look blank, consider excluding: ${blank.join(', ')}`);
  return { files, decals, blank, missing, changed };
}

module.exports = { buildDecals, parseRewards, parseStrings, classify, sourcePaths, DECALS_DIR, TILE, COLS, DEFAULT_PATHS };

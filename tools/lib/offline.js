'use strict';
// Offline package: a .zip of the public campaign package, for playing without the launcher.
//
// The contents are exactly what the *published* update-manifest.json on R2 lists
// (never local builds that weren't deployed), taken from payload/ and checked by hash (what the launcher
// would install), laid out like the StarCraft II folder, plus a "Play SC Evo.cmd"
// that starts the campaign the way the launcher does and a README. Melee maps are
// left out: they only work after the launcher prepares them for a game.
//
// The archives are MPQ (already compressed), so the zip stores them as is. Store
// mode needs nothing but zlib.crc32; the writer below is the whole format.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { REPO_ROOT, PAYLOAD_DIR, TOOLS_DIR, R2_BASE, stripJunk } = require('./config');
const { hashOf } = require('./hashcache');

const OFFLINE_DIR = path.join(REPO_ROOT, 'offline');
const README_TEMPLATE = path.join(TOOLS_DIR, 'offline-readme.txt');
const MAX32 = 0xffffffff;

/* ── zip writer (store only, no Zip64) ───────────────────────────────────── */

function dosDateTime(date) {
  const d = new Date(date);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function localHeader(name, { time, date }, crc, size) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);        // version needed
  h.writeUInt16LE(0x0800, 6);    // UTF-8 names
  h.writeUInt16LE(0, 8);         // stored
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(crc >>> 0, 14);
  h.writeUInt32LE(size, 18);     // compressed size = size (stored)
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, name]);
}

function centralHeader(e) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);        // made by: MS-DOS, 2.0
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(e.dos.time, 12);
  h.writeUInt16LE(e.dos.date, 14);
  h.writeUInt32LE(e.crc >>> 0, 16);
  h.writeUInt32LE(e.size, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(e.name.length, 28);
  // extra, comment, disk, internal attrs, external attrs: all 0
  h.writeUInt32LE(e.offset, 42);
  return Buffer.concat([h, e.name]);
}

function endRecord(count, cdSize, cdOffset) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  return h;
}

/**
 * entries: [{ name: 'Maps/a.SC2Map', abs: '<file>' } | { name, data: Buffer, mtime? }]
 * Writes to out + '.partial' and renames when complete, so a failed run never
 * leaves a zip that looks finished. onProgress({ name, index, total, doneBytes, totalBytes }).
 */
async function writeZip(out, entries, onProgress = () => {}) {
  const sized = entries.map((e) => {
    const st = e.abs ? fs.statSync(e.abs) : null;
    return { ...e, size: st ? st.size : e.data.length, mtime: st ? st.mtime : (e.mtime ?? new Date()) };
  });
  const totalBytes = sized.reduce((n, e) => n + e.size, 0);
  if (sized.length > 0xffff) throw new Error('Too many files for a zip without Zip64');
  if (totalBytes > MAX32 - 64 * 1024 * 1024) throw new Error(`The package is ${(totalBytes / 2 ** 30).toFixed(2)} GB; zips over 4 GB need Zip64, which this writer doesn't do`);

  const partial = `${out}.partial`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fh = await fs.promises.open(partial, 'w');
  const written = [];
  let pos = 0, doneBytes = 0, lastEmit = 0;
  try {
    for (const [i, e] of sized.entries()) {
      const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
      const dos = dosDateTime(e.mtime);
      const offset = pos;
      const header = localHeader(name, dos, 0, e.size);
      await fh.write(header, 0, header.length, pos);
      pos += header.length;

      let crc = 0, count = 0;
      const emit = (force) => {
        const now = Date.now();
        if (force || now - lastEmit > 200) { lastEmit = now; onProgress({ name: e.name, index: i + 1, total: sized.length, doneBytes, totalBytes }); }
      };
      emit(true);
      if (e.abs) {
        for await (const chunk of fs.createReadStream(e.abs, { highWaterMark: 1 << 20 })) {
          crc = zlib.crc32(chunk, crc);
          await fh.write(chunk, 0, chunk.length, pos);
          pos += chunk.length; count += chunk.length; doneBytes += chunk.length;
          emit(false);
        }
      } else {
        crc = zlib.crc32(e.data);
        await fh.write(e.data, 0, e.data.length, pos);
        pos += e.data.length; count += e.data.length; doneBytes += e.data.length;
      }
      if (count !== e.size) throw new Error(`${e.name} changed size while it was being added`);

      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32LE(crc >>> 0, 0);
      await fh.write(crcBuf, 0, 4, offset + 14);
      written.push({ name, dos, crc, size: e.size, offset });
    }

    const cdOffset = pos;
    for (const e of written) {
      const h = centralHeader(e);
      await fh.write(h, 0, h.length, pos);
      pos += h.length;
    }
    const end = endRecord(written.length, pos - cdOffset, cdOffset);
    await fh.write(end, 0, end.length, pos);
    pos += end.length;
  } catch (err) {
    await fh.close();
    fs.rmSync(partial, { force: true });
    throw err;
  }
  await fh.close();
  fs.renameSync(partial, out);
  return { file: out, bytes: pos, entries: written.length };
}

/* ── the offline package ─────────────────────────────────────────────────── */

const crlf = (text) => text.replace(/\r?\n/g, '\r\n');

// Starts the campaign the way the launcher does (main.js: SC2Switcher_x64.exe <EvoCompleteLauncher.SC2Map>).
const PLAY_CMD = crlf(`@echo off
rem SC Evo offline: starts the campaign without the launcher. Keep this file in the StarCraft II folder.
set "SC2=%~dp0"
if not exist "%SC2%Support64\\SC2Switcher_x64.exe" (
  echo This file must be in your StarCraft II folder, next to Support64, Maps and Mods.
  echo Extract the whole zip into the StarCraft II folder and run it again.
  pause
  exit /b 1
)
if not exist "%SC2%Maps\\SCEvo\\EvoCompleteLauncher.SC2Map" (
  echo Maps\\SCEvo\\EvoCompleteLauncher.SC2Map is missing. Extract the whole zip into the StarCraft II folder.
  pause
  exit /b 1
)
start "" /D "%SC2%" "%SC2%Support64\\SC2Switcher_x64.exe" "%SC2%Maps\\SCEvo\\EvoCompleteLauncher.SC2Map"
`);

function offlineFileName(versions) {
  const v = (s) => String(s || 'unknown').replace(/[^\w.-]+/g, '_');
  return `SCEvo_Offline_Campaign-${v(versions?.campaign)}_Evo-${v(versions?.multiplayer)}.zip`;
}

// The campaign manifest players are served right now. The package is built only
// from it: local builds (and the local manifest Build regenerates) can contain
// work in progress that was never deployed.
async function fetchPublishedManifest(timeoutMs = 15000) {
  const url = `${R2_BASE}/manifests/update-manifest.json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`R2 answered ${res.status}`);
    return JSON.parse(stripJunk(await res.text()));
  } catch (err) {
    throw new Error(`Can't read the published manifest from R2 (${err.name === 'AbortError' ? 'timed out' : err.message}); the offline package is only built from published files.`);
  } finally { clearTimeout(timer); }
}

// The published files, from payload/. Each must hash to exactly what's published;
// a file built but not deployed (e.g. work in progress) stops the package.
async function packageFiles(manifest, { payloadDir = PAYLOAD_DIR, hash = hashOf } = {}) {
  const files = (manifest?.modules ?? []).flatMap((m) => m.files ?? []);
  if (!files.length) throw new Error('The published campaign manifest lists no files.');
  const out = [], wrong = [];
  for (const f of files) {
    const abs = path.join(payloadDir, ...f.path.split('/'));
    if (!fs.existsSync(abs)) { wrong.push(`${f.path} (missing from payload/)`); continue; }
    if ((await hash(abs)).hash !== f.hash) { wrong.push(f.path); continue; }
    out.push({ name: f.path, abs });
  }
  if (wrong.length) {
    throw new Error(`These files in payload/ are not the published versions (built but not deployed?): ${wrong.join(', ')}. ` +
      'Deploy them first, or rebuild them from the published state.');
  }
  return out;
}

async function buildOfflineZip({ outDir = OFFLINE_DIR, onProgress, log = () => {} } = {}) {
  log('Reading the published campaign manifest from R2…');
  const manifest = await fetchPublishedManifest();
  const files = await packageFiles(manifest);
  const versions = manifest.versions ?? {};
  const readme = fs.readFileSync(README_TEMPLATE, 'utf8')
    .replace(/\{campaign\}/g, versions.campaign ?? '?')
    .replace(/\{multiplayer\}/g, versions.multiplayer ?? '?')
    .replace(/\{date\}/g, new Date().toISOString().slice(0, 10));
  const entries = [
    { name: 'SC Evo - README.txt', data: Buffer.from(crlf(readme), 'utf8') },
    { name: 'Play SC Evo.cmd', data: Buffer.from(PLAY_CMD, 'utf8') },
    ...files,
  ];
  const out = path.join(outDir, offlineFileName(versions));
  log(`Writing ${path.relative(REPO_ROOT, out)}: ${files.length} files from the published campaign manifest ` +
    `(campaign ${versions.campaign ?? '?'} / Evo ${versions.multiplayer ?? '?'}, published ${manifest.lastUpdated ?? '?'})`);
  const r = await writeZip(out, entries, onProgress);
  log(`Done: ${(r.bytes / 2 ** 20).toFixed(0)} MB, ${r.entries} entries`);
  return r;
}

module.exports = { buildOfflineZip, writeZip, packageFiles, offlineFileName, OFFLINE_DIR };

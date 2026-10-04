// Vendored from sc-evo-launcher/electron/melee/mapInfo.js. Keep in sync: the deploy tool must read maps
// exactly the way the launcher does. Copy the file over again rather than editing it here.

// ═══════════════════════════════════════════════════════════════════════════
// Lobby metadata for a melee map (folder .SC2Map or packed MPQ):
// name, description, max players, thumbnail, and whether the launcher can run it.
// Pure Node (no Electron APIs) so it can be unit-tested.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { openArchive } = require("./mpq");

// ─── Map sources: one API over folder maps and packed archives ───
function openMap(mapPath) {
  if (fs.statSync(mapPath).isDirectory()) {
    return {
      kind: "folder",
      read: (name) => { const p = path.join(mapPath, ...name.split(/[\\/]/)); return fs.existsSync(p) ? fs.readFileSync(p) : null; },
      close: () => {},
    };
  }
  const a = openArchive(mapPath);
  return { kind: "archive", read: (name) => a.read(name.replace(/\//g, "\\")), close: () => a.close() };
}

// ─── Strings ───
function parseGameStrings(buf) {
  const out = {};
  if (!buf) return out;
  for (const line of buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

// DocumentHeader stores "<key>" + locale fourcc ("SUne" = enUS) + u16 length + UTF-8 value, once per locale.
function headerString(buf, key, locale = "SUne") {
  if (!buf) return null;
  let i = buf.indexOf(Buffer.from(key + locale, "ascii"));
  if (i < 0) i = buf.indexOf(Buffer.from(key, "ascii"));
  if (i < 0) return null;
  const at = i + key.length + 4;
  if (at + 2 > buf.length) return null;
  const len = buf.readUInt16LE(at);
  return buf.subarray(at + 2, at + 2 + len).toString("utf8");
}

// SC2 text markup → plain text.
const plain = (s) => (s || "").replace(/<n\/>/g, "\n").replace(/<[^>]+>/g, "").trim();

// Map size and tileset from t3Terrain.xml. dim counts vertices, so cells are one less.
function readTerrain(buf) {
  if (!buf) return { size: null, tileset: null };
  const head = buf.subarray(0, 4096).toString("utf8");
  const dim = /<heightMap[^>]*\sdim="(\d+)\s+(\d+)/.exec(head);
  const ts = /<heightMap[^>]*\stileSet="([^"]+)"/.exec(head);
  return { size: dim ? { w: Number(dim[1]) - 1, h: Number(dim[2]) - 1 } : null, tileset: ts ? ts[1] : null };
}

// ─── Images ───
function decodeTga(buf) {
  const idLen = buf[0], cmapType = buf[1], type = buf[2];
  const w = buf.readUInt16LE(12), h = buf.readUInt16LE(14), bpp = buf[16], desc = buf[17];
  if (cmapType !== 0 || ![2, 10].includes(type) || ![24, 32].includes(bpp)) throw new Error(`TGA: unsupported format (type ${type}, ${bpp} bpp)`);
  const px = bpp / 8, rgba = Buffer.alloc(w * h * 4);
  let src = 18 + idLen, i = 0;
  const put = (o) => { rgba[i * 4] = buf[o + 2]; rgba[i * 4 + 1] = buf[o + 1]; rgba[i * 4 + 2] = buf[o]; rgba[i * 4 + 3] = px === 4 ? buf[o + 3] : 255; i++; };
  if (type === 2) { while (i < w * h) { put(src); src += px; } }
  else {
    while (i < w * h) {
      const hdr = buf[src++], count = (hdr & 0x7f) + 1;
      if (hdr & 0x80) { for (let k = 0; k < count; k++) put(src); src += px; }
      else { for (let k = 0; k < count; k++) { put(src); src += px; } }
    }
  }
  if (!(desc & 0x20)) { // bottom-up: flip rows
    const row = w * 4, tmp = Buffer.alloc(row);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row, b = (h - 1 - y) * row;
      rgba.copy(tmp, 0, a, a + row); rgba.copy(rgba, a, b, b + row); tmp.copy(rgba, b);
    }
  }
  return { w, h, rgba };
}

// 8-bit, non-interlaced RGB/RGBA PNGs only (what map previews use); anything else returns null.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace || (ctype !== 2 && ctype !== 6)) return null;
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride), rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = cur[x * bpp]; rgba[o + 1] = cur[x * bpp + 1]; rgba[o + 2] = cur[x * bpp + 2]; rgba[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    cur.copy(prev);
  }
  return { w, h, rgba };
}

// Crops to the bounding box of non-dark pixels (minimaps carry a black border outside the playable area).
function trimDark(img, threshold = 12) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const o = (y * img.w + x) * 4, p = img.rgba;
    if (p[o + 3] && Math.max(p[o], p[o + 1], p[o + 2]) > threshold) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return img;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w === img.w && h === img.h) return img;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) img.rgba.copy(out, y * w * 4, ((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4);
  return { w, h, rgba: out };
}

// Box-filter downscale so the longest side is at most `max`.
function downscale(img, max) {
  const s = Math.max(1, Math.ceil(Math.max(img.w, img.h) / max));
  if (s === 1) return img;
  const w = Math.floor(img.w / s), h = Math.floor(img.h / s), out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const acc = [0, 0, 0, 0];
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
      const o = ((y * s + dy) * img.w + (x * s + dx)) * 4;
      for (let c = 0; c < 4; c++) acc[c] += img.rgba[o + c];
    }
    for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = Math.round(acc[c] / (s * s));
  }
  return { w, h, rgba: out };
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function encodePng(img) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((img.w * 4 + 1) * img.h);
  for (let y = 0; y < img.h; y++) img.rgba.copy(raw, y * (img.w * 4 + 1) + 1, y * img.w * 4, (y + 1) * img.w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString("base64")}`;

// The minimap (black border trimmed), else the first screenshot listed in DocumentInfo that exists.
function readThumbnail(src, docInfo, max) {
  const minimap = src.read("Minimap.tga");
  if (minimap) {
    try { return dataUrl("image/png", encodePng(downscale(trimDark(decodeTga(minimap)), max))); } catch { /* fall back to screenshots */ }
  }
  const shots = [];
  const m = /<Screenshot>[\s\S]*?<File>([\s\S]*?)<\/File>/.exec(docInfo || "");
  if (m) for (const v of m[1].matchAll(/<Value>([^<]+)<\/Value>/g)) shots.push(v[1].trim());
  const candidates = [];
  for (const s of shots) candidates.push(`enUS.SC2Assets/${s}`, s);
  for (const name of candidates) {
    const buf = src.read(name);
    if (!buf) continue;
    const ext = path.extname(name).toLowerCase();
    try {
      if (ext === ".png") { const img = decodePng(buf); return dataUrl("image/png", img ? encodePng(downscale(img, max)) : buf); }
      if (ext === ".jpg" || ext === ".jpeg") return dataUrl("image/jpeg", buf);
      if (ext === ".tga") return dataUrl("image/png", encodePng(downscale(decodeTga(buf), max)));
    } catch { /* try the next candidate */ }
  }
  return null;
}

// ─── Public API ───
function readMapInfo(mapPath, { thumbnailSize = 256 } = {}) {
  const src = openMap(mapPath);
  try {
    const strings = parseGameStrings(src.read("enUS.SC2Data/LocalizedData/GameStrings.txt"));
    const header = src.read("DocumentHeader");
    const name = plain(strings["DocInfo/Name"] || headerString(header, "DocInfo/Name")) || path.basename(mapPath, path.extname(mapPath));
    const description = plain(strings["DocInfo/DescLong"] || headerString(header, "DocInfo/DescLong"));
    const modes = plain(strings["DocInfo/DescShort"] || headerString(header, "DocInfo/DescShort"));
    const { size, tileset } = readTerrain(src.read("t3Terrain.xml"));
    const objects = src.read("Objects");
    const players = objects ? (objects.toString("utf8").match(/Type="StartLoc"/g) || []).length : 0;
    const script = src.read("MapScript.galaxy");
    const docInfo = src.read("DocumentInfo");
    let supported = true, reason = null;
    if (!script) { supported = false; reason = "noScript"; }
    else if (!script.toString("utf8").includes("MeleeInitResources();")) { supported = false; reason = "notMelee"; }
    else if (players < 2) { supported = false; reason = "tooFewStartLocations"; }
    return {
      path: mapPath, kind: src.kind, name, description, modes, size, tileset, players, supported, reason,
      thumbnail: readThumbnail(src, docInfo && docInfo.toString("utf8"), thumbnailSize),
    };
  } finally { src.close(); }
}

module.exports = { readMapInfo, openMap, decodeTga, encodePng, downscale, trimDark, headerString, parseGameStrings };

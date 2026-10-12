// Vendored from sc-evo-launcher/electron/melee/mpq.js. Keep in sync: the deploy tool must read maps
// exactly the way the launcher does. Copy the file over again rather than editing it here.

// ═══════════════════════════════════════════════════════════════════════════
// Read-only MPQ reader for packed .SC2Map / .s2ma archives.
// Supports format v1–v3 with the classic hash and block tables, encrypted
// tables and files, single-unit and sectored files, and zlib / bzip2 sectors.
// HET/BET tables (v3+) are ignored: SC2 archives always carry the classic ones.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const bzip2 = require("./bzip2");

// ─── Crypt table and hashing ───
const CRYPT = (() => {
  const t = new Uint32Array(0x500);
  let seed = 0x00100001;
  for (let i = 0; i < 0x100; i++) {
    for (let j = 0, idx = i; j < 5; j++, idx += 0x100) {
      seed = (seed * 125 + 3) % 0x2aaaab; const hi = (seed & 0xffff) << 16;
      seed = (seed * 125 + 3) % 0x2aaaab; t[idx] = (hi | (seed & 0xffff)) >>> 0;
    }
  }
  return t;
})();

const HASH_OFFSET = 0, HASH_A = 1, HASH_B = 2, HASH_KEY = 3;

function hashString(str, type) {
  let s1 = 0x7fed7fed, s2 = 0xeeeeeeee;
  const up = str.toUpperCase().replace(/\//g, "\\");
  for (let i = 0; i < up.length; i++) {
    const ch = up.charCodeAt(i) & 0xff;
    s1 = (CRYPT[(type << 8) + ch] ^ ((s1 + s2) >>> 0)) >>> 0;
    s2 = (ch + s1 + s2 + (s2 << 5) + 3) >>> 0;
  }
  return s1 >>> 0;
}

// Decrypts a buffer of little-endian u32 words in place.
function decryptBlock(buf, key) {
  let seed = 0xeeeeeeee;
  const n = buf.length >>> 2;
  for (let i = 0; i < n; i++) {
    seed = (seed + CRYPT[0x400 + (key & 0xff)]) >>> 0;
    const v = (buf.readUInt32LE(i * 4) ^ ((key + seed) >>> 0)) >>> 0;
    key = ((((~key << 0x15) + 0x11111111) >>> 0) | (key >>> 0x0b)) >>> 0;
    seed = (v + seed + (seed << 5) + 3) >>> 0;
    buf.writeUInt32LE(v, i * 4);
  }
  return buf;
}

// ─── Block flags ───
const F_IMPLODE = 0x00000100, F_COMPRESS = 0x00000200, F_ENCRYPTED = 0x00010000, F_FIX_KEY = 0x00020000,
  F_PATCH = 0x00100000, F_SINGLE = 0x01000000, F_DELETE = 0x02000000, F_CRC = 0x04000000, F_EXISTS = 0x80000000;

function decompressSector(data, expectedSize) {
  if (data.length >= expectedSize) return data.subarray(0, expectedSize);
  let mask = data[0], body = data.subarray(1);
  if (mask & 0x10) { body = bzip2.decompress(body); mask &= ~0x10; }
  if (mask & 0x02) { body = zlib.inflateSync(body); mask &= ~0x02; }
  if (mask) throw new Error(`MPQ: unsupported compression 0x${data[0].toString(16)}`);
  return body;
}

class MpqArchive {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, "r");
    try { this._readHeader(); this._readTables(); } catch (e) { this.close(); throw e; }
  }

  close() { if (this.fd != null) { fs.closeSync(this.fd); this.fd = null; } }

  _read(pos, len) {
    const b = Buffer.alloc(len);
    const n = fs.readSync(this.fd, b, 0, len, pos);
    if (n !== len) throw new Error("MPQ: unexpected end of file");
    return b;
  }

  _readHeader() {
    const size = fs.fstatSync(this.fd).size;
    for (let off = 0; off + 32 <= size; off += 0x200) {
      const sig = this._read(off, 4).readUInt32LE(0);
      if (sig === 0x1b51504d) { // user data header: points at the real header
        const ud = this._read(off, 16);
        off += ud.readUInt32LE(8) - 0x200; continue;
      }
      if (sig !== 0x1a51504d) continue;
      const h = this._read(off, 0x2c > size - off ? size - off : 0x2c);
      this.base = off;
      this.formatVersion = h.readUInt16LE(12);
      this.sectorSize = 512 << h.readUInt16LE(14);
      let hashPos = h.readUInt32LE(16), blockPos = h.readUInt32LE(20);
      this.hashCount = h.readUInt32LE(24); this.blockCount = h.readUInt32LE(28);
      this.hiBlockPos = 0;
      if (this.formatVersion >= 1 && h.length >= 0x2c) {
        this.hiBlockPos = Number(h.readBigUInt64LE(32));
        hashPos += h.readUInt16LE(40) * 0x100000000;
        blockPos += h.readUInt16LE(42) * 0x100000000;
      }
      this.hashPos = hashPos; this.blockPos = blockPos;
      return;
    }
    throw new Error("MPQ: no archive header found");
  }

  _readTables() {
    const ht = decryptBlock(this._read(this.base + this.hashPos, this.hashCount * 16), hashString("(hash table)", HASH_KEY));
    const bt = decryptBlock(this._read(this.base + this.blockPos, this.blockCount * 16), hashString("(block table)", HASH_KEY));
    const hi = this.hiBlockPos ? this._read(this.base + this.hiBlockPos, this.blockCount * 2) : null;
    this.hashes = [];
    for (let i = 0; i < this.hashCount; i++) {
      this.hashes.push({ a: ht.readUInt32LE(i * 16), b: ht.readUInt32LE(i * 16 + 4), block: ht.readUInt32LE(i * 16 + 12) });
    }
    this.blocks = [];
    for (let i = 0; i < this.blockCount; i++) {
      this.blocks.push({
        pos: bt.readUInt32LE(i * 16) + (hi ? hi.readUInt16LE(i * 2) * 0x100000000 : 0),
        csize: bt.readUInt32LE(i * 16 + 4), size: bt.readUInt32LE(i * 16 + 8), flags: bt.readUInt32LE(i * 16 + 12) >>> 0,
      });
    }
  }

  _findBlock(name) {
    const start = hashString(name, HASH_OFFSET) % this.hashCount;
    const a = hashString(name, HASH_A), b = hashString(name, HASH_B);
    for (let i = 0; i < this.hashCount; i++) {
      const e = this.hashes[(start + i) % this.hashCount];
      if (e.block === 0xffffffff) return null;               // empty: end of chain
      if (e.a === a && e.b === b && e.block !== 0xfffffffe) {
        const blk = this.blocks[e.block];
        if (blk && (blk.flags & F_EXISTS) && !(blk.flags & F_DELETE)) return blk;
      }
    }
    return null;
  }

  has(name) { return !!this._findBlock(name); }

  read(name) {
    const blk = this._findBlock(name);
    if (!blk) return null;
    if (blk.flags & F_PATCH) throw new Error(`MPQ: patch files are not supported (${name})`);
    if ((blk.flags & F_IMPLODE) && !(blk.flags & F_COMPRESS)) throw new Error(`MPQ: imploded files are not supported (${name})`);
    let key = 0;
    if (blk.flags & F_ENCRYPTED) {
      key = hashString(name.split(/[\\/]/).pop(), HASH_KEY);
      if (blk.flags & F_FIX_KEY) key = ((key + blk.pos) ^ blk.size) >>> 0;
    }
    const pos = this.base + blk.pos;
    const compressed = (blk.flags & F_COMPRESS) !== 0;

    if (blk.flags & F_SINGLE) {
      let data = this._read(pos, blk.csize);
      if (key) data = decryptBlock(Buffer.from(data), key);
      return compressed ? decompressSector(data, blk.size) : data.subarray(0, blk.size);
    }

    const nSectors = Math.ceil(blk.size / this.sectorSize);
    if (!compressed) {
      const out = Buffer.from(this._read(pos, blk.size));
      if (key) for (let s = 0; s < nSectors; s++) {
        const from = s * this.sectorSize, to = Math.min(from + this.sectorSize, blk.size);
        const sec = Buffer.from(out.subarray(from, from + ((to - from) & ~3)));
        decryptBlock(sec, (key + s) >>> 0); sec.copy(out, from);
      }
      return out;
    }
    const nOffsets = nSectors + 1 + ((blk.flags & F_CRC) ? 1 : 0);
    let offs = this._read(pos, nOffsets * 4);
    if (key) offs = decryptBlock(Buffer.from(offs), (key - 1) >>> 0);
    const parts = [];
    for (let s = 0; s < nSectors; s++) {
      const a = offs.readUInt32LE(s * 4), b = offs.readUInt32LE(s * 4 + 4);
      let sec = this._read(pos + a, b - a);
      if (key) sec = decryptBlock(Buffer.from(sec), (key + s) >>> 0);
      const expected = Math.min(this.sectorSize, blk.size - s * this.sectorSize);
      parts.push(decompressSector(sec, expected));
    }
    return Buffer.concat(parts, blk.size);
  }

  // Names from (listfile). Archives without one cannot be listed.
  list() {
    const lf = this.read("(listfile)");
    if (!lf) throw new Error("MPQ: archive has no (listfile)");
    return lf.toString("utf8").split(/[;\r\n]+/).map((s) => s.trim()).filter(Boolean)
      .filter((n) => this.has(n));
  }

  // Writes every listed file under dir, keeping folders. Skips the MPQ bookkeeping files.
  extractAll(dir) {
    const names = this.list().filter((n) => !/^\((listfile|attributes|signature)\)$/i.test(n));
    for (const n of names) {
      const dest = path.join(dir, ...n.split(/[\\/]/));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, this.read(n));
    }
    return names.length;
  }
}

function openArchive(filePath) { return new MpqArchive(filePath); }

module.exports = { openArchive, hashString };

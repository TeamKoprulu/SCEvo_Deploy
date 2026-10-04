// Vendored from sc-evo-launcher/electron/melee/bzip2.js. Keep in sync: the deploy tool must read maps
// exactly the way the launcher does. Copy the file over again rather than editing it here.

// ═══════════════════════════════════════════════════════════════════════════
// Minimal bzip2 decoder (read-only). MPQ sectors in SC2 maps can be bzip2;
// Node's zlib has no bzip2, so this implements the format directly.
// Supports normal (non-randomised) blocks, which is all bzip2 writes today.
// ═══════════════════════════════════════════════════════════════════════════

class BitReader {
  constructor(buf, start = 0) { this.buf = buf; this.pos = start; this.acc = 0; this.n = 0; }
  // Reads n (<= 24) bits, most significant first.
  read(n) {
    while (this.n < n) {
      if (this.pos >= this.buf.length) throw new Error("bzip2: unexpected end of data");
      this.acc = ((this.acc << 8) | this.buf[this.pos++]) >>> 0; this.n += 8;
    }
    this.n -= n;
    return (this.acc >>> this.n) & ((1 << n) - 1);
  }
}

class ByteSink {
  constructor(size) { this.buf = Buffer.allocUnsafe(Math.max(size, 1024)); this.len = 0; }
  push(b) {
    if (this.len === this.buf.length) { const nb = Buffer.allocUnsafe(this.buf.length * 2); this.buf.copy(nb); this.buf = nb; }
    this.buf[this.len++] = b;
  }
  result() { return this.buf.subarray(0, this.len); }
}

// Canonical Huffman table from code lengths.
function makeTable(lengths) {
  let minLen = 32, maxLen = 0;
  for (const l of lengths) { if (l < minLen) minLen = l; if (l > maxLen) maxLen = l; }
  const count = new Int32Array(maxLen + 1);
  for (const l of lengths) count[l]++;
  const first = new Int32Array(maxLen + 1), firstIdx = new Int32Array(maxLen + 1), perm = [];
  let code = 0, idx = 0;
  for (let len = minLen; len <= maxLen; len++) {
    first[len] = code; firstIdx[len] = idx;
    for (let s = 0; s < lengths.length; s++) if (lengths[s] === len) perm.push(s);
    code = (code + count[len]) << 1; idx += count[len];
  }
  return { minLen, maxLen, count, first, firstIdx, perm };
}

function decodeSymbol(br, t) {
  let code = 0;
  for (let len = 1; len <= t.maxLen; len++) {
    code = (code << 1) | br.read(1);
    if (len >= t.minLen) {
      const off = code - t.first[len];
      if (off >= 0 && off < t.count[len]) return t.perm[t.firstIdx[len] + off];
    }
  }
  throw new Error("bzip2: bad Huffman code");
}

function decodeBlock(br, blockMax, out) {
  br.read(16); br.read(16);                      // block CRC (not verified)
  if (br.read(1)) throw new Error("bzip2: randomised blocks are not supported");
  const origPtr = br.read(24);

  // Symbol map
  const used = br.read(16), seq = [];
  for (let i = 0; i < 16; i++) if (used & (0x8000 >> i)) {
    const bits = br.read(16);
    for (let j = 0; j < 16; j++) if (bits & (0x8000 >> j)) seq.push(i * 16 + j);
  }
  if (!seq.length) throw new Error("bzip2: empty symbol map");
  const alphaSize = seq.length + 2;

  // Huffman groups and selectors
  const nGroups = br.read(3), nSelectors = br.read(15);
  if (nGroups < 2 || nGroups > 6 || nSelectors < 1) throw new Error("bzip2: bad group header");
  const mtfGroups = []; for (let i = 0; i < nGroups; i++) mtfGroups.push(i);
  const selectors = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let j = 0; while (br.read(1)) { if (++j >= nGroups) throw new Error("bzip2: bad selector"); }
    const v = mtfGroups[j]; mtfGroups.splice(j, 1); mtfGroups.unshift(v); selectors[i] = v;
  }
  const tables = [];
  for (let g = 0; g < nGroups; g++) {
    const lengths = new Array(alphaSize); let len = br.read(5);
    for (let s = 0; s < alphaSize; s++) {
      while (br.read(1)) len += br.read(1) ? -1 : 1;
      if (len < 1 || len > 20) throw new Error("bzip2: bad code length");
      lengths[s] = len;
    }
    tables.push(makeTable(lengths));
  }

  // MTF / RLE2 decode into tt
  const eob = alphaSize - 1, mtf = seq.slice(), tt = new Uint32Array(blockMax), counts = new Int32Array(256);
  let n = 0, groupPos = 0, sel = 0, table = null, runLen = 0, runPos = 1;
  for (;;) {
    if (groupPos === 0) { if (sel >= nSelectors) throw new Error("bzip2: out of selectors"); table = tables[selectors[sel++]]; groupPos = 50; }
    groupPos--;
    const sym = decodeSymbol(br, table);
    if (sym <= 1) { runLen += (sym + 1) * runPos; runPos <<= 1; continue; }
    if (runLen) {
      const b = mtf[0]; if (n + runLen > blockMax) throw new Error("bzip2: block overflow");
      counts[b] += runLen; while (runLen--) tt[n++] = b; runLen = 0; runPos = 1;
    }
    if (sym === eob) break;
    const b = mtf[sym - 1]; mtf.splice(sym - 1, 1); mtf.unshift(b);
    if (n >= blockMax) throw new Error("bzip2: block overflow");
    counts[b]++; tt[n++] = b;
  }
  if (origPtr >= n) throw new Error("bzip2: bad origPtr");

  // Inverse BWT
  const cf = new Int32Array(256); for (let i = 0, s = 0; i < 256; i++) { cf[i] = s; s += counts[i]; }
  for (let i = 0; i < n; i++) { const b = tt[i] & 0xff; tt[cf[b]++] |= i << 8; }
  let pos = tt[origPtr] >>> 8;

  // Undo the initial run-length encoding (4 equal bytes + count)
  let last = -1, same = 0;
  for (let i = 0; i < n; i++) {
    const entry = tt[pos]; const b = entry & 0xff; pos = entry >>> 8;
    if (same === 4) { for (let k = 0; k < b; k++) out.push(last); same = 0; last = -1; continue; }
    out.push(b);
    if (b === last) same++; else { last = b; same = 1; }
  }
}

function decompress(buf) {
  if (buf[0] !== 0x42 || buf[1] !== 0x5a || buf[2] !== 0x68) throw new Error("bzip2: bad signature");
  const level = buf[3] - 0x30; if (level < 1 || level > 9) throw new Error("bzip2: bad block size");
  const br = new BitReader(buf, 4);
  const out = new ByteSink(buf.length * 4);
  for (;;) {
    const hi = br.read(24), lo = br.read(24);
    if (hi === 0x314159 && lo === 0x265359) { decodeBlock(br, level * 100000, out); continue; }
    if (hi === 0x177245 && lo === 0x385090) break;
    throw new Error("bzip2: bad block magic");
  }
  return Buffer.from(out.result());
}

module.exports = { decompress };

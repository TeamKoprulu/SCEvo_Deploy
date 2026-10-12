'use strict';
// Minimal DDS reader: the top mip of DXT1/DXT5 textures (what SC2 decals use) as RGBA.

function rgb565(c) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

// One 4x4 colour block (8 bytes at off) -> 16 RGB triples. dxt1 enables the 3-colour + transparent mode.
function colorBlock(buf, off, dxt1) {
  const c0 = buf.readUInt16LE(off), c1 = buf.readUInt16LE(off + 2);
  const p0 = rgb565(c0), p1 = rgb565(c1);
  const pal = [p0, p1];
  if (!dxt1 || c0 > c1) {
    pal.push(p0.map((v, i) => Math.round((2 * v + p1[i]) / 3)), p0.map((v, i) => Math.round((v + 2 * p1[i]) / 3)));
  } else {
    pal.push(p0.map((v, i) => (v + p1[i]) >> 1), null);
  }
  const bits = buf.readUInt32LE(off + 4);
  const out = [];
  for (let i = 0; i < 16; i++) out.push(pal[(bits >>> (2 * i)) & 3]);
  return out;
}

// DXT5 alpha block (8 bytes) -> 16 alpha values.
function alphaBlock(buf, off) {
  const a0 = buf[off], a1 = buf[off + 1];
  const pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i <= 6; i++) pal.push(Math.round(((7 - i) * a0 + i * a1) / 7));
  else { for (let i = 1; i <= 4; i++) pal.push(Math.round(((5 - i) * a0 + i * a1) / 5)); pal.push(0, 255); }
  // 48 bits of 3-bit indices, little-endian
  let lo = buf[off + 2] | (buf[off + 3] << 8) | (buf[off + 4] << 16);
  let hi = buf[off + 5] | (buf[off + 6] << 8) | (buf[off + 7] << 16);
  const out = [];
  for (let i = 0; i < 8; i++) { out.push(pal[lo & 7]); lo >>>= 3; }
  for (let i = 0; i < 8; i++) { out.push(pal[hi & 7]); hi >>>= 3; }
  return out;
}

function readHeader(buf) {
  if (buf.toString('latin1', 0, 4) !== 'DDS ') throw new Error('Not a DDS file');
  const height = buf.readUInt32LE(12), width = buf.readUInt32LE(16);
  const fourCC = buf.toString('latin1', 84, 88);
  return { width, height, fourCC, dataOffset: 128 };
}

// -> { width, height, data: Uint8ClampedArray RGBA } (top mip only)
function decodeDds(buf) {
  const h = readHeader(buf);
  const dxt1 = h.fourCC === 'DXT1';
  if (!dxt1 && h.fourCC !== 'DXT5') throw new Error(`Unsupported DDS format ${h.fourCC}`);
  const { width, height } = h;
  const data = new Uint8ClampedArray(width * height * 4);
  const bw = Math.max(1, Math.ceil(width / 4)), bh = Math.max(1, Math.ceil(height / 4));
  const step = dxt1 ? 8 : 16;
  let off = h.dataOffset;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, off += step) {
      const alpha = dxt1 ? null : alphaBlock(buf, off);
      const colors = colorBlock(buf, dxt1 ? off : off + 8, dxt1);
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
        if (x >= width || y >= height) continue;
        const p = (y * width + x) * 4, c = colors[i];
        if (!c) { data[p + 3] = 0; continue; }
        data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2];
        data[p + 3] = alpha ? alpha[i] : 255;
      }
    }
  }
  return { width, height, data };
}

// Box-filter downsample by an integer factor, alpha-weighted so transparent edges don't darken.
function downsample(img, size) {
  const f = img.width / size;
  if (!Number.isInteger(f) || img.height / size !== f) throw new Error(`Can't downsample ${img.width}x${img.height} to ${size}`);
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const p = ((y * f + dy) * img.width + (x * f + dx)) * 4, al = img.data[p + 3];
          r += img.data[p] * al; g += img.data[p + 1] * al; b += img.data[p + 2] * al; a += al;
        }
      }
      const o = (y * size + x) * 4;
      if (a) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
      out[o + 3] = a / (f * f);
    }
  }
  return { width: size, height: size, data: out };
}

module.exports = { decodeDds, downsample, readHeader, colorBlock, alphaBlock };

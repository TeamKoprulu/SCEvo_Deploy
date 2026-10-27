'use strict';
// Hero background images for the launcher's channels (Manifest → Public / Beta → Hero background).
// Saved as assets/launcher/<branch>-<hash>.<ext>; the Assets folder uploads with the campaign
// package, before the manifests that point at it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ASSETS_DIR, publicBase } = require('./config');

const DIR = path.join(ASSETS_DIR, 'launcher');
const TYPES = { webp: 'webp', png: 'png', jpg: 'jpg', jpeg: 'jpg' };
const MAX_BYTES = 3 * 1024 * 1024;

// body: { branch: "public"|"beta", filename, data (base64) } → { url, size, sha256, file }
function saveBackground({ branch, filename, data } = {}) {
  if (!['public', 'beta'].includes(branch)) throw new Error('branch must be public or beta');
  const ext = TYPES[String(path.extname(filename || '')).slice(1).toLowerCase()];
  if (!ext) throw new Error('Use a .webp, .png or .jpg image');
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw new Error('The image is empty');
  if (buf.length > MAX_BYTES) throw new Error(`The image is ${(buf.length / 1048576).toFixed(1)} MB; keep it under 3 MB (webp works best)`);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const file = `${branch}-${sha256.slice(0, 12)}.${ext}`;
  fs.mkdirSync(DIR, { recursive: true });
  const abs = path.join(DIR, file);
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);
  return { url: `${publicBase()}/assets/launcher/${file}`, size: buf.length, sha256, file };
}

module.exports = { saveBackground, MAX_BYTES, DIR };

'use strict';
// Campaign hero media for the launcher's channels (Manifest → Public / Beta → Hero editor): the
// video and its still. Saved as assets/hero/<branch>-<hash>.<ext>, so a new file never reuses a
// cached URL; the Assets folder uploads with the campaign (or assets) package, before the
// manifests that point at it. The launcher reads them through the manifest's "hero" section
// (sc-evo-launcher electron/heroMedia.js, src/heroLayout.mjs).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ASSETS_DIR, publicBase } = require('./config');

const DIR = path.join(ASSETS_DIR, 'hero');
const KINDS = {
  video: { exts: { webm: 'webm' }, max: 40 * 1024 * 1024, hint: 'Use a .webm video (VP9 keeps transparency)' },
  poster: { exts: { webp: 'webp', png: 'png', jpg: 'jpg', jpeg: 'jpg' }, max: 3 * 1024 * 1024, hint: 'Use a .webp, .png or .jpg image' },
};
const FILE_RE = /^(public|beta)-[0-9a-f]{12}\.(webm|webp|png|jpg)$/;

function store(branch, buf, ext) {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const file = `${branch}-${sha256.slice(0, 12)}.${ext}`;
  fs.mkdirSync(DIR, { recursive: true });
  const abs = path.join(DIR, file);
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);
  return { url: `${publicBase()}/assets/hero/${file}`, size: buf.length, sha256, file };
}

// body: { branch: "public"|"beta", kind: "video"|"poster", filename, data (base64) } → { url, size, sha256, file }
function saveHeroMedia({ branch, kind, filename, data } = {}) {
  if (!['public', 'beta'].includes(branch)) throw new Error('branch must be public or beta');
  const k = KINDS[kind];
  if (!k) throw new Error('kind must be video or poster');
  const ext = k.exts[String(path.extname(filename || '')).slice(1).toLowerCase()];
  if (!ext) throw new Error(k.hint);
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw new Error('The file is empty');
  if (buf.length > k.max) throw new Error(`The file is ${(buf.length / 1048576).toFixed(1)} MB; keep it under ${k.max / 1048576} MB`);
  return store(branch, buf, ext);
}

// A still for a saved video: the frame `at` (0–1) of the way in, transparency kept, at most
// 1280 px wide; the site's scripts/build-video-posters.mjs recipe. Needs ffmpeg and ffprobe.
function makePoster({ branch, file, at = 0.4 } = {}) {
  if (!['public', 'beta'].includes(branch)) throw new Error('branch must be public or beta');
  const src = fileFor(file);
  if (!src || !src.endsWith('.webm')) throw new Error('No such hero video');
  let probe;
  try {
    probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height:stream_tags=alpha_mode:format=duration', '-of', 'json', src], { encoding: 'utf8', windowsHide: true }));
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? 'ffmpeg/ffprobe not found on PATH (winget install Gyan.FFmpeg); choose a still by hand instead' : `ffprobe failed: ${String(e.message).split('\n')[0]}`);
  }
  const s = probe.streams?.[0] || {};
  const alpha = /^1$/.test(s.tags?.alpha_mode || s.tags?.ALPHA_MODE || '');
  const t = Math.max(0, (parseFloat(probe.format?.duration) || 0) * Math.min(1, Math.max(0, Number(at) || 0)));
  const out = path.join(require('node:os').tmpdir(), `scevo-hero-${process.pid}-${Date.now()}.webp`);
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...(s.codec_name === 'vp9' ? ['-c:v', 'libvpx-vp9'] : []),
      '-ss', String(t), '-i', src, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2",
      '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p', '-c:v', 'libwebp', '-quality', '80', out], { windowsHide: true });
    return { ...store(branch, fs.readFileSync(out), 'webp'), video: { width: s.width || null, height: s.height || null, alpha } };
  } catch (e) {
    throw new Error(`Could not make a still: ${String(e.message).split('\n')[0]}`);
  } finally { fs.rmSync(out, { force: true }); }
}

// The local copy of a hero file (by name, or by its published URL), or null.
function fileFor(nameOrUrl) {
  const name = String(nameOrUrl || '').split(/[?#]/)[0].split('/').pop();
  return FILE_RE.test(name) ? path.join(DIR, name) : null;
}

module.exports = { saveHeroMedia, makePoster, fileFor, DIR, FILE_RE, KINDS };

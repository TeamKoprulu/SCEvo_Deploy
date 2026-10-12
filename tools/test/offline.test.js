'use strict';
// node --test tools/test   (temp files only; reads the zip back with an independent parser)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { writeZip, offlineFileName, packageFiles } = require('../lib/offline');

// End record -> central directory -> each local header and its stored data.
function readZip(file) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end record present');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extra + comment;
    assert.equal(buf.readUInt32LE(offset), 0x04034b50);
    assert.equal(buf.readUInt32LE(offset + 14), crc, `${name}: local and central CRC agree`);
    assert.equal(buf.readUInt32LE(offset + 22), size);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    out.push({ name, flags, method, crc, data: buf.subarray(start, start + size) });
  }
  return out;
}

test('writes a stored zip any reader can open: names, sizes, CRCs and bytes intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-zip-'));
  const big = Buffer.alloc(3 * 1024 * 1024 + 7, 0);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  const mod = path.join(dir, 'SCEvo Core.SC2Mod');
  fs.writeFileSync(mod, big);
  const out = path.join(dir, 'out', 'pkg.zip');
  const seen = [];
  const r = await writeZip(out, [
    { name: 'SC Evo - README.txt', data: Buffer.from('hello\r\n') },
    { name: 'Mods\\SC Evolution Complete\\SCEvo Core.SC2Mod', abs: mod },
  ], (p) => seen.push(p));

  assert.equal(r.entries, 2);
  assert.equal(fs.existsSync(`${out}.partial`), false, 'no partial left behind');
  const entries = readZip(out);
  assert.deepEqual(entries.map((e) => e.name), ['SC Evo - README.txt', 'Mods/SC Evolution Complete/SCEvo Core.SC2Mod']);
  assert.ok(entries.every((e) => e.method === 0 && (e.flags & 0x0800)), 'stored, UTF-8 names');
  assert.equal(entries[1].data.equals(big), true);
  for (const e of entries) assert.equal(e.crc, zlib.crc32(e.data) >>> 0);
  assert.equal(seen.at(-1).totalBytes, big.length + 7);
});

test('a failed write leaves neither the zip nor a partial file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-zip-'));
  const out = path.join(dir, 'pkg.zip');
  await assert.rejects(writeZip(out, [{ name: 'missing', abs: path.join(dir, 'nope.SC2Mod') }]));
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(`${out}.partial`), false);
});

// A payload folder plus the "published" manifest describing it.
function publishedPayload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-pub-'));
  const files = { 'Mods/SC Evolution Complete/SCEvo_Core.SC2Mod': 'core v1', 'Maps/SCEvo/Loomings0Legacy.SC2Map': 'map v1' };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, ...rel.split('/')), text);
  }
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const manifest = { modules: [{ files: Object.entries(files).map(([p, t]) => ({ path: p, size: t.length, hash: sha(t) })) }] };
  const hash = async (abs) => ({ hash: sha(fs.readFileSync(abs)) });
  return { dir, manifest, hash };
}

test('packages the payload when every file is the published version', async () => {
  const { dir, manifest, hash } = publishedPayload();
  const list = await packageFiles(manifest, { payloadDir: dir, hash });
  assert.deepEqual(list.map((f) => f.name), manifest.modules[0].files.map((f) => f.path));
});

test('refuses a built-but-not-deployed file, even at the same size', async () => {
  const { dir, manifest, hash } = publishedPayload();
  fs.writeFileSync(path.join(dir, 'Mods', 'SC Evolution Complete', 'SCEvo_Core.SC2Mod'), 'core v2'); // WIP build, same length
  await assert.rejects(packageFiles(manifest, { payloadDir: dir, hash }), /not the published versions.*SCEvo_Core\.SC2Mod/);
});

test('refuses when a published file is missing from payload/', async () => {
  const { dir, manifest, hash } = publishedPayload();
  fs.rmSync(path.join(dir, 'Maps', 'SCEvo', 'Loomings0Legacy.SC2Map'));
  await assert.rejects(packageFiles(manifest, { payloadDir: dir, hash }), /Loomings0Legacy\.SC2Map \(missing from payload\/\)/);
});

test('the file name carries both versions', () => {
  assert.equal(offlineFileName({ campaign: '0.6.1', multiplayer: '1.21' }), 'SCEvo_Offline_Campaign-0.6.1_Evo-1.21.zip');
  assert.equal(offlineFileName({}), 'SCEvo_Offline_Campaign-unknown_Evo-unknown.zip');
});

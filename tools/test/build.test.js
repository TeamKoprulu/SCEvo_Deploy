'use strict';
// node --test tools/test   (temp files only; nothing touches the payload folders)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fingerprint, isStale } = require('../lib/build');
const { modesFor } = require('../lib/mapmeta');

function sourceAndPayload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-build-'));
  const src = path.join(dir, 'Core.SC2Mod');
  fs.mkdirSync(path.join(src, 'Base.SC2Data'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Base.SC2Data', 'GameData.xml'), '<x/>');
  const payload = path.join(dir, 'payload.SC2Mod');
  fs.writeFileSync(payload, 'MPQ');
  return { src, payload, edited: path.join(src, 'Base.SC2Data', 'GameData.xml') };
}
const at = (iso) => new Date(iso);

test('a payload built before the source was last edited is stale', () => {
  const { src, payload, edited } = sourceAndPayload();
  fs.utimesSync(payload, at('2026-07-22'), at('2026-07-22'));
  fs.utimesSync(edited, at('2026-09-28'), at('2026-09-28'));
  assert.equal(isStale(fingerprint(src), payload), true);
});

test('a payload built after the last edit is not stale', () => {
  const { src, payload, edited } = sourceAndPayload();
  fs.utimesSync(edited, at('2026-09-28'), at('2026-09-28'));
  fs.utimesSync(payload, at('2026-10-04'), at('2026-10-04'));
  assert.equal(isStale(fingerprint(src), payload), false);
});

test('a copied packed source (same mtime) is not stale; a missing payload is', () => {
  const { payload } = sourceAndPayload();
  const packed = `${payload}.copy`;
  fs.copyFileSync(payload, packed);
  fs.utimesSync(packed, at('2026-08-01'), at('2026-08-01'));
  fs.utimesSync(payload, at('2026-08-01'), at('2026-08-01'));
  assert.equal(isStale(fingerprint(packed), payload), false);
  assert.equal(isStale(fingerprint(packed), `${payload}.missing`), true);
});

test('modesFor keeps real mode text and derives the rest from start locations', () => {
  assert.equal(modesFor('1v1', 4), '1v1');
  assert.equal(modesFor('2v2', 4), '2v2');
  assert.equal(modesFor('FFA', 3), 'FFA');
  assert.equal(modesFor('2', 2), '1v1');
  assert.equal(modesFor('4', 4), '2v2 · FFA');
  assert.equal(modesFor('4 - 6', 6), '3v3 · FFA');
  assert.equal(modesFor('', 3), 'FFA');
  assert.equal(modesFor('', 8), '4v4 · FFA');
  assert.equal(modesFor('', 0), '');
});

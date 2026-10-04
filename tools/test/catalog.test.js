'use strict';
// node --test tools/test   (no SC2 install needed: builds a fake one in a temp folder)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../lib/catalog');
const { depsOf } = require('../lib/mapmeta');
const { sameContent, groupModules } = require('../lib/generate');

function fakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
  const mk = (rel, file) => {
    const abs = path.join(root, rel);
    if (file) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'MPQ'); }
    else fs.mkdirSync(abs, { recursive: true });
  };
  mk('Mods\\SC Evolution Complete\\SCEvo_Core.SC2Mod');
  mk('Mods\\SC Evolution Complete\\SCEvo_Extension.SC2Mod');
  mk('Mods\\SC Evolution Complete\\SCEvo_Multi.SC2Mod');
  mk('Maps\\SCEvo_MPMaps\\SCEVO_Sylphid.SC2Map');
  mk('Maps\\SCEvo_MPMaps\\SEL_1v1\\Golden Wall SEL.SC2Map', true);
  mk('Maps\\SCEvo_MPMaps\\Map Overviews');
  return root;
}

const roots = [
  { rel: 'Mods\\SC Evolution Complete', kind: 'mod' },
  { rel: 'Maps\\SCEvo_MPMaps', kind: 'map', depth: 2 },
];

test('discover finds folder and packed sources, depth-limited', () => {
  const root = fakeInstall();
  const { found } = catalog.discover(root, roots);
  const names = found.map((f) => f.source);
  assert.ok(names.includes('Maps\\SCEvo_MPMaps\\SEL_1v1\\Golden Wall SEL.SC2Map'));
  assert.equal(found.find((f) => f.source.endsWith('Golden Wall SEL.SC2Map')).packed, true);
  assert.equal(found.find((f) => f.source.endsWith('SCEVO_Sylphid.SC2Map')).packed, false);
  assert.ok(!names.some((n) => n.includes('Map Overviews')));
});

test('decisions persist: ignored stays ignored after a save/load round-trip', () => {
  const root = fakeInstall();
  const file = path.join(root, 'deploy-catalog.json');
  const doc = { ...catalog.emptyCatalog(), roots };
  catalog.upsert(doc, 'Mods\\SC Evolution Complete\\SCEvo_Core.SC2Mod', { package: 'campaign', channel: 'public' });
  catalog.ignore(doc, 'Mods\\SC Evolution Complete\\SCEvo_Extension.SC2Mod');
  catalog.save(doc, file);

  const again = catalog.load(file); // as a fresh session would
  const { rows } = catalog.classify(again, root);
  const st = (s) => rows.find((r) => r.source.endsWith(s)).status;
  assert.equal(st('SCEvo_Extension.SC2Mod'), 'ignored');
  assert.equal(st('SCEvo_Core.SC2Mod'), 'tracked');
  assert.equal(st('SCEvo_Multi.SC2Mod'), 'new');
});

test('a corrupt catalog is an error, never an empty catalog', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-')), 'deploy-catalog.json');
  fs.writeFileSync(file, '{ "items": [ ');
  assert.throws(() => catalog.load(file), /not valid JSON/);
});

test('promote is a channel change; melee maps get a stable opaque target', () => {
  const doc = catalog.emptyCatalog();
  catalog.upsert(doc, 'Maps\\SCEvo\\X.SC2Map', { package: 'campaign', channel: 'beta' });
  assert.deepEqual(catalog.channelsOf(catalog.findItem(doc, 'Maps\\SCEvo\\X.SC2Map')), ['beta']);
  catalog.upsert(doc, 'Maps\\SCEvo\\X.SC2Map', { channel: 'both' });
  assert.deepEqual(catalog.channelsOf(catalog.findItem(doc, 'maps\\scevo\\x.sc2map')), ['public', 'beta']);
  assert.equal(catalog.targetOf(catalog.findItem(doc, 'Maps\\SCEvo\\X.SC2Map')), 'Maps/SCEvo/X.SC2Map');

  catalog.upsert(doc, 'Maps\\SCEvo_MPMaps\\A.SC2Map', { package: 'melee', channel: 'public' });
  const m = catalog.findItem(doc, 'Maps\\SCEvo_MPMaps\\A.SC2Map');
  assert.match(m.mapId, /^[0-9a-f]{10}$/);
  assert.equal(catalog.targetOf(m), `maps/${m.mapId}.evm`);
  const id = m.mapId;
  catalog.upsert(doc, 'Maps\\SCEvo_MPMaps\\A.SC2Map', { channel: 'off' });
  catalog.upsert(doc, 'Maps\\SCEvo_MPMaps\\A.SC2Map', { channel: 'public' });
  assert.equal(catalog.findItem(doc, 'Maps\\SCEvo_MPMaps\\A.SC2Map').mapId, id, 'map id never changes');
});

test('validation rejects bad channels and item/ignore conflicts', () => {
  const doc = catalog.emptyCatalog();
  doc.items.push({ source: 'Mods\\X.SC2Mod', package: 'melee', channel: 'beta' });
  assert.throws(() => catalog.validate(doc), /not valid for melee/);
  const doc2 = catalog.emptyCatalog();
  doc2.items.push({ source: 'Mods\\Y.SC2Mod', package: 'campaign', channel: 'public' });
  doc2.ignore.push('mods\\y.sc2mod');
  assert.throws(() => catalog.validate(doc2), /both an item and ignored/);
});

test('map dependencies: only SCEvo mods, as install paths', () => {
  const xml = `<DocInfo><Dependencies>
    <Value>bnet:Void (Mod)/0.0/999,file:Mods/Void.SC2Mod</Value>
    <Value>bnet:SCEvo_MultiArtMod_Public/0.0/464472,file:Mods\\SC Evolution Complete\\SCEvo_MultiArtMod.SC2Mod</Value>
  </Dependencies></DocInfo>`;
  assert.deepEqual(depsOf(xml), ['Mods/SC Evolution Complete/SCEvo_MultiArtMod.SC2Mod']);
});

test('generated manifests compare without lastUpdated; modules group by id', () => {
  assert.ok(sameContent({ lastUpdated: 'a', x: 1 }, { lastUpdated: 'b', x: 1 }));
  assert.ok(!sameContent({ x: 1 }, { x: 2 }));
  const mods = groupModules([
    { item: { source: 'Mods\\A.SC2Mod', module: { type: 'core' } }, file: { path: 'Mods/A.SC2Mod' } },
    { item: { source: 'Mods\\B.SC2Mod' }, file: { path: 'Mods/B.SC2Mod' } },
  ]);
  assert.deepEqual(mods.map((m) => [m.id, m.type, m.files.length]), [['a', 'core', 1], ['b', '', 1]]);
});

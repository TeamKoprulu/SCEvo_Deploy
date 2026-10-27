'use strict';
// node --test tools/test   (pure checks: no SC2 install, no MPQEditor)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mb = require('../lib/meleebeta');
const catalog = require('../lib/catalog');

const CORE = 'Mods\\SC Evolution Complete\\SCEvo_Core.SC2Mod';
const MULTI = 'Mods\\SC Evolution Complete\\SCEvo_Multi.SC2Mod';
const LEGACY = 'Mods\\SC Evolution Complete\\SCEvo_Legacy.SC2Mod';
const ASSETS = 'Mods\\SC Evolution Complete\\SCEvo_Assets.SC2Mod';
const docOf = (items) => ({ items, ignore: [] });

test('rewriteDeps points branched mods at the beta folder, file-only', () => {
  const info = '<Value>bnet:SCEvo Core/0.0/999,file:Mods\\SC Evolution Complete\\SCEvo_Core.SC2Mod</Value>\n'
    + '<Value>bnet:SCEvo Assets/0.0/999,file:Mods\\SC Evolution Complete\\SCEvo_Assets.SC2Mod</Value>';
  const out = mb.rewriteDeps(info, new Set(['scevo_core']));
  assert.match(out, /<Value>file:Mods\\SC Evolution Complete Beta\\SCEvo_Core\.SC2Mod<\/Value>/);
  assert.match(out, /bnet:SCEvo Assets\/0\.0\/999,file:Mods\\SC Evolution Complete\\SCEvo_Assets\.SC2Mod/);
  assert.equal(mb.rewriteDeps(info, new Set()), info);
});

test('rewriteDeps works on a DocumentHeader read as latin1 (null-terminated)', () => {
  const header = Buffer.concat([Buffer.from([0x48, 0x32, 0x00, 0xff]), Buffer.from('file:Mods/SC Evolution Complete/SCEvo_Core.SC2Mod\0', 'latin1')]).toString('latin1');
  const out = Buffer.from(mb.rewriteDeps(header, new Set(['scevo_core'])), 'latin1');
  assert.ok(out.includes(Buffer.from('file:Mods\\SC Evolution Complete Beta\\SCEvo_Core.SC2Mod\0', 'latin1')));
  assert.equal(out[3], 0xff);
});

test('depsOf lists Evo mods by lower-case name', () => {
  const deps = mb.depsOf('file:Mods\\SC Evolution Complete\\SCEvo_Core.SC2Mod x bnet:A/0.0/1,file:Mods/SC Evolution Complete/SCEvo_Assets.SC2Mod');
  assert.deepEqual([...deps].sort(), ['scevo_assets', 'scevo_core']);
});

test('canTag and targetOf only accept direct children of the Evo mods folder', () => {
  assert.ok(mb.canTag(CORE));
  assert.ok(!mb.canTag('Mods\\SC Evolution Complete\\Sub\\X.SC2Mod'));
  assert.ok(!mb.canTag('Maps\\SCEvo_MPMaps\\A.SC2Map'));
  assert.equal(mb.targetOf({ source: CORE }), 'Mods/SC Evolution Complete Beta/SCEvo_Core.SC2Mod');
});

test('closureProblems flags untagged melee and core mods that load a tagged mod', () => {
  const doc = docOf([
    { source: CORE, package: 'campaign', channel: 'public', module: { type: 'core' }, meleeBeta: true },
    { source: MULTI, package: 'melee', channel: 'public' },
    { source: LEGACY, package: 'campaign', channel: 'public', module: { type: 'core' } },
    { source: ASSETS, package: 'campaign', channel: 'public', module: { type: 'core' } },
  ]);
  const rows = doc.items.map((it) => ({ source: it.source, abs: it.source }));
  const docs = {
    [MULTI]: 'file:Mods\\SC Evolution Complete\\SCEvo_Core.SC2Mod',
    [LEGACY]: 'file:Mods\\SC Evolution Complete\\SCEvo_Core.SC2Mod',
    [ASSETS]: '',
  };
  const read = (abs) => ({ DocumentInfo: docs[abs] ?? '' });
  const problems = mb.closureProblems(doc, rows, read);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('SCEvo_Multi')));
  assert.ok(problems.some((p) => p.includes('SCEvo_Legacy')));

  doc.items[1].meleeBeta = true;
  doc.items[2].meleeBeta = true;
  assert.deepEqual(mb.closureProblems(doc, rows, read), []);
});

test('closureProblems is empty when nothing is tagged', () => {
  assert.deepEqual(mb.closureProblems(docOf([{ source: MULTI, package: 'melee', channel: 'public' }]), [], () => { throw new Error('unread'); }), []);
});

test('meleeBetaDoc: disabled publishes no modules; enabled reports a missing code and unbuilt mods', async () => {
  const doc = docOf([{ source: CORE, package: 'campaign', channel: 'public', meleeBeta: true }]);
  const off = await mb.meleeBetaDoc(doc, { enabled: false, name: 'Closed beta', code: 'abc' });
  assert.equal(off.betaEnabled, false);
  assert.equal(off.modules, undefined);
  assert.equal(off.betaName, 'Closed beta');
  assert.match(off.codeHash, /^[0-9a-f]{64}$/);

  const problems = [];
  const on = await mb.meleeBetaDoc(doc, { enabled: true, codeHash: '' }, problems);
  assert.deepEqual(on.modules, []);
  assert.ok(problems.some((p) => /no code/.test(p)));
  assert.ok(problems.some((p) => /isn't built/.test(p)));
});

test('catalog rejects meleeBeta on a map', () => {
  const doc = { version: 1, roots: [], items: [{ source: 'Maps\\SCEvo_MPMaps\\A.SC2Map', package: 'melee', channel: 'public', meleeBeta: true }], ignore: [], melee: { version: '1.0.0' } };
  assert.throws(() => catalog.validate(doc), /only mods can be tagged for the melee beta/);
});

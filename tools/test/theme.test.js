'use strict';
// Launcher colour themes and the episode shown, without changing what older launchers read.
const test = require('node:test');
const assert = require('node:assert/strict');
const mf = require('../lib/manifest');

test('the beta theme keeps the 1.3.x shape, derived from one colour', () => {
  const b = mf.buildBetaManifest({ meta: { accentColor: '#FF6600', betaEnabled: false } });
  assert.deepEqual(b.theme, { accentColor: '#ff6600', accentColorDim: '#ff660044', particleColor: '255, 102, 0', bgGlow: '#ff660015', badgeText: 'BETA', badgeColor: '#ff6600' });
  assert.equal(mf.buildBetaManifest({ meta: { accentColor: 'nonsense' } }).theme.accentColor, '#ff6600');
  assert.equal(mf.buildBetaManifest({ meta: { accentColor: '#0af' } }).theme.accentColor, '#00aaff');
});

test('a public manifest without colour or episode is unchanged', () => {
  const p = mf.buildPublicManifest({ versions: { multiplayer: '1', campaign: '2' }, modules: [] });
  assert.deepEqual(Object.keys(p), ['schemaVersion', 'lastUpdated', 'versions', 'criticalUpdate', 'modules']);
  assert.deepEqual(Object.keys(mf.buildPublicManifest({ versions: {}, modules: [], accentColor: '', episode: null })),
    ['schemaVersion', 'lastUpdated', 'versions', 'criticalUpdate', 'modules']);
});

test('a public colour and episode are written when set', () => {
  const p = mf.buildPublicManifest({ versions: {}, modules: [], accentColor: '#E0483B', episode: '1' });
  assert.equal(p.theme.accentColor, '#e0483b');
  assert.equal(p.theme.particleColor, '224, 72, 59');
  assert.equal(p.theme.badgeText, null);
  assert.equal(p.episode, 1);
  assert.equal(mf.buildBetaManifest({ meta: { episode: 1 } }).episode, 1);
  assert.equal('episode' in mf.buildBetaManifest({ meta: {} }), false);
});

test('a channel background is written only when valid', () => {
  const bg = { url: 'https://scevo.download/assets/launcher/public-abc.webp', size: 1234, sha256: 'a'.repeat(64) };
  assert.deepEqual(mf.buildPublicManifest({ versions: {}, modules: [], background: bg }).background, bg);
  assert.equal('background' in mf.buildPublicManifest({ versions: {}, modules: [], background: { url: 'javascript:x' } }), false);
  assert.equal('background' in mf.buildPublicManifest({ versions: {}, modules: [], background: null }), false);
  assert.deepEqual(mf.buildBetaManifest({ meta: { background: bg } }).background, bg);
});

test('background uploads are checked before anything is written', () => {
  const { saveBackground } = require('../lib/backgrounds');
  assert.throws(() => saveBackground({ branch: 'melee', filename: 'a.webp', data: 'AA==' }), /public or beta/);
  assert.throws(() => saveBackground({ branch: 'public', filename: 'a.gif', data: 'AA==' }), /webp/);
  assert.throws(() => saveBackground({ branch: 'public', filename: 'a.webp', data: '' }), /empty/);
  assert.throws(() => saveBackground({ branch: 'public', filename: 'a.webp', data: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64') }), /under 3 MB/);
});

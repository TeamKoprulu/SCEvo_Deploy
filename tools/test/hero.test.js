'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mf = require('../lib/manifest');
const hero = require('../lib/hero');

const A = (name) => ({ url: `https://scevo.download/assets/hero/public-${name}`, size: 10, sha256: 'a'.repeat(64) });

test('cleanHero keeps placed pieces, the video with its still and layer, and drops the rest', () => {
  const h = mf.cleanHero({
    video: { ...A('0123456789ab.webm'), poster: A('0123456789ab.webp'), x: 220.4567, y: 86, scale: 1.2, layer: 'sideways', junk: 1 },
    logo: { x: -190, y: 100 },
    emblem: { x: 'left' },
    extra: true,
  });
  assert.deepEqual(h, {
    video: { ...A('0123456789ab.webm'), poster: A('0123456789ab.webp'), x: 220.457, y: 86, scale: 1.2, layer: 'behind' },
    logo: { x: -190, y: 100 },
  });
});

test('cleanHero: a video under the vignette is behind the logo too', () => {
  const v = mf.cleanHero({ video: { ...A('0123456789ab.webm'), layer: 'front', vignette: 'below' } }).video;
  assert.equal(v.layer, 'behind');
  assert.equal(v.vignette, 'below');
  assert.equal('vignette' in mf.cleanHero({ video: { ...A('0123456789ab.webm'), vignette: 'above' } }).video, false, 'above is the default, not written');
});

test('cleanHero: hidden emblem, clamped numbers, nothing left = null', () => {
  assert.deepEqual(mf.cleanHero({ emblem: { show: false, x: 3 }, logo: { scale: 99 } }), { emblem: { show: false }, logo: { scale: 4 } });
  assert.equal(mf.cleanHero({ video: { url: 'https://x/a.mp4' }, logo: {} }), null, 'only .webm videos');
  assert.equal(mf.cleanHero(null), null);
});

test('both channel manifests carry the hero', () => {
  const hero = { logo: { x: 10, y: 20, scale: 1 } };
  assert.deepEqual(mf.buildPublicManifest({ versions: {}, modules: [], hero }).hero, hero);
  assert.deepEqual(mf.buildBetaManifest({ meta: { betaEnabled: false, hero }, modules: [] }).hero, hero);
  assert.equal('hero' in mf.buildPublicManifest({ versions: {}, modules: [] }), false);
});

test('saveHeroMedia refuses wrong channels, kinds, types and sizes before writing anything', () => {
  const data = Buffer.from('x').toString('base64');
  assert.throws(() => hero.saveHeroMedia({ branch: 'melee', kind: 'video', filename: 'a.webm', data }), /branch/);
  assert.throws(() => hero.saveHeroMedia({ branch: 'public', kind: 'music', filename: 'a.webm', data }), /kind/);
  assert.throws(() => hero.saveHeroMedia({ branch: 'public', kind: 'video', filename: 'a.mp4', data }), /webm/);
  assert.throws(() => hero.saveHeroMedia({ branch: 'public', kind: 'poster', filename: 'a.webm', data }), /webp/);
  assert.throws(() => hero.saveHeroMedia({ branch: 'public', kind: 'video', filename: 'a.webm', data: '' }), /empty/);
});

test('fileFor maps hero file names and their URLs only', () => {
  assert.ok(hero.fileFor('https://scevo.download/assets/hero/beta-0123456789ab.webm?v=1').endsWith('beta-0123456789ab.webm'));
  assert.equal(hero.fileFor('../deploy-config.json'), null);
  assert.equal(hero.fileFor('public-xyz.webm'), null);
});

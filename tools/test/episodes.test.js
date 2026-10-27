'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEpisodeStyle, DEFAULT_TUNE } = require('../lib/episodes');

// The shape of EvoSite assets/js/campaign-page.js (regex values included, so it can't be evaluated).
const SOURCE = `
  var EPISODE_STYLE = {
    0: { emblemFilter: 'none', glowColor: '#6ff06a', postMatch: /loomings/i,   // glowColor: tints glow
      tune: { emblemSize: 0.75, emblemY: -0.1, glowScale: 1.125, glowX: 0.012, glowY: 0 } },   // comment
    1: { emblemFilter: 'hue-rotate(90deg)', postMatch: /rebel-?yell/i, bgTint: true, glowBreathe: true,
      tune: { emblemSize: 0.7, emblemY: -.1, glowScale: 1.5 } }
  };
  function toEpisodes(list) {}`;

test('parseEpisodeStyle reads glow colour, filter, breathe and tune per episode', () => {
  const s = parseEpisodeStyle(SOURCE);
  assert.deepEqual(s[0], { glowColor: '#6ff06a', emblemFilter: 'none', glowBreathe: false,
    tune: { emblemSize: 0.75, emblemY: -0.1, glowScale: 1.125, glowX: 0.012, glowY: 0 } });
  assert.equal(s[1].glowColor, null);
  assert.equal(s[1].emblemFilter, 'hue-rotate(90deg)');
  assert.equal(s[1].glowBreathe, true);
  // Missing tune keys fall back to the site's defaults; ".1" style numbers parse.
  assert.deepEqual(s[1].tune, { ...DEFAULT_TUNE, emblemSize: 0.7, emblemY: -0.1, glowScale: 1.5 });
});

test('parseEpisodeStyle returns nothing for a page without EPISODE_STYLE', () => {
  assert.deepEqual(parseEpisodeStyle('var x = 1;'), {});
  assert.deepEqual(parseEpisodeStyle(''), {});
});

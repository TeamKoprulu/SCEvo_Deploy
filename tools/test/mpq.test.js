'use strict';
// node --test tools/test   (MPQEditor not needed: only the script text is checked)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mpqScript, hashTableSizeFor } = require('../lib/mpq');

test('mpqScript lines tokenise cleanly (MPQEditor splits on spaces)', () => {
  const lines = mpqScript('build-temp\\Sanctuary_III_SEL.SC2Map', 'build-temp\\_src_Sanctuary_III_SEL.SC2Map', 128)
    .split('\r\n').filter(Boolean);
  assert.deepEqual(lines.map((l) => l.split(' ').length), [3, 5, 2]);
});

test('hashTableSizeFor keeps the load factor near 50%', () => {
  assert.equal(hashTableSizeFor(0), 4);
  assert.equal(hashTableSizeFor(50), 128);
  assert.equal(hashTableSizeFor(64), 128);
});

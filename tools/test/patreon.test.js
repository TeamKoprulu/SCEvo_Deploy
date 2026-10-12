'use strict';
// node --test tools/test   (no network: posts are fixtures and image downloads are stubbed)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bakePatreonSlots } = require('../lib/patreon');
const news = require('../lib/news');
const { checkNewsFeed } = require('../lib/verify');
const { R2_BASE } = require('../lib/config');

// Newest first, as loadPatreonPosts returns them.
const POSTS = [
  { id: '3', title: 'June/July', date: '2026-08-21T21:31:59.000+00:00', url: 'https://patreon/3', imageUrl: 'https://img/3.png?sig', imageKey: 'https://img/3.png' },
  { id: '2', title: 'Beta Codes', date: '2026-06-14T00:55:13.000+00:00', url: 'https://patreon/2', imageUrl: null, imageKey: null },
  { id: '1', title: 'May', date: '2026-06-07T19:34:36.000+00:00', url: 'https://patreon/1', imageUrl: 'https://img/1.png?sig', imageKey: 'https://img/1.png' },
];
const download = async (p) => `${R2_BASE}/assets/news/patreon-${p.id}.png`;

test('bakes posts by index, skipping posts shown above', async () => {
  const feed = [
    { id: 'a', kind: 'patreon', rule: { index: 1 } },
    { id: 'b', kind: 'patreon', rule: { index: 1 }, exclude: 'used' },
    { id: 'c', kind: 'patreon', rule: { index: 3 } },
  ];
  const warnings = await bakePatreonSlots(feed, POSTS, { rehost: true, download });
  assert.deepEqual(warnings, []);
  assert.deepEqual(feed.map((s) => s.title), ['June/July', 'Beta Codes', 'May']);
  assert.equal(feed[0].date, 'August 21, 2026');
  assert.equal(feed[0].badge, 'Patreon');
  assert.equal(feed[0].linkUrl, 'https://patreon/3');
  assert.equal(feed[0].imageUrl, `${R2_BASE}/assets/news/patreon-3.png`);
  assert.equal('imageUrl' in feed[1], false, 'a post without an image gets the text header');
});

test('preview keeps Patreon\'s own image URL', async () => {
  const feed = [{ kind: 'patreon', rule: { index: 1 } }];
  await bakePatreonSlots(feed, POSTS, { download: () => assert.fail('preview must not download') });
  assert.equal(feed[0].imageUrl, 'https://img/3.png?sig');
});

test('overrides win, noImage drops the image, and removed overrides do not linger', async () => {
  const slot = { kind: 'patreon', rule: { index: 1 }, noImage: true, overrides: { title: 'Mine', imageBg: '#2a1b0a' } };
  await bakePatreonSlots([slot], POSTS, { rehost: true, download });
  assert.equal(slot.title, 'Mine');
  assert.equal(slot.imageBg, '#2a1b0a');
  assert.equal('imageUrl' in slot, false);
  delete slot.overrides.imageBg;
  await bakePatreonSlots([slot], POSTS, { rehost: true, download });
  assert.equal('imageBg' in slot, false);
});

test('unreachable Patreon or a missing post keeps what the card showed before', async () => {
  const slot = { id: 'x', kind: 'patreon', rule: { index: 9 }, title: 'Old', imageUrl: 'old.png' };
  assert.match((await bakePatreonSlots([slot], [], { download }))[0], /could not be reached/);
  assert.match((await bakePatreonSlots([slot], POSTS, { download }))[0], /no post #9/);
  assert.equal(slot.title, 'Old');
  assert.equal(slot.imageUrl, 'old.png');
});

test('launchers render a baked slot as a custom card', async () => {
  const feed = [{ id: 'p', kind: 'patreon', rule: { index: 1 }, overrides: { imageText: 'DEV' } }];
  await bakePatreonSlots(feed, POSTS, { rehost: true, download });
  const [card] = news.resolveFeed(feed, []);
  assert.equal(card.title, 'June/July');
  assert.equal(card.imageText, 'DEV');
  assert.equal('overrides' in card, false);
  assert.equal('kind' in card, false);
});

test('checkNewsFeed: patreon slots and re-hosted images', () => {
  const codes = (feed) => checkNewsFeed({ cards: [], feed }).map((f) => f.code);
  assert.deepEqual(codes([{ id: 'a', kind: 'patreon', rule: { index: 1 }, title: 'T' }]), []);
  assert.deepEqual(codes([{ id: 'a', kind: 'patreon', rule: { index: 1 } }]), ['news-patreon-unbaked']);
  assert.deepEqual(codes([{ id: 'a', kind: 'patreon', rule: { index: 0 }, title: 'T' }]), ['news-feed-index']);
  assert.deepEqual(codes([{ id: 'a', kind: 'custom', imageUrl: `${R2_BASE}/assets/news/does-not-exist.png` }]), ['news-image-missing']);
});

test('patreon cards are credited to Kat unless an override names someone else', async () => {
  const feed = [
    { id: 'a', kind: 'patreon', rule: { index: 1 } },
    { id: 'b', kind: 'patreon', rule: { index: 2 }, overrides: { author: 'HyperONE' } },
  ];
  await bakePatreonSlots(feed, POSTS, { rehost: true, download });
  assert.equal(feed[0].author, 'Kat');
  assert.equal(feed[1].author, 'HyperONE');
  const authors = { Kat: { name: 'Angel "Kat" Huerta' }, HyperONE: { name: 'HyperONE' } };
  const cards = news.resolveFeed(feed, [], { authors });
  assert.deepEqual(cards.map((c) => c.author), ['Angel "Kat" Huerta', 'HyperONE']);
});

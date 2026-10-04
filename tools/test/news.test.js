'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const news = require('../lib/news');
const { checkNewsFeed } = require('../lib/verify');

const POSTS = news.sortPosts([
  { link: '/posts/a.html', title: 'A', date: '2026-01-01', tags: 'Update', description: 'a' },
  { link: '/posts/b.html', title: 'B', date: '2026-02-01', tags: 'Campaign', description: 'b' },
  { link: '/posts/c.html', title: 'C', date: '2026-03-01', tags: 'Update, Balance', description: 'c' },
]);

test('snapshot for older launchers keeps locales and resolves posts in English', () => {
  const feed = [
    { id: 'camp', kind: 'post', rule: { tag: 'Campaign' }, locales: { es: { excerpt: 'Hola' } } },
    { id: 'recent', kind: 'post', rule: { index: 1 }, exclude: 'used' },
    { id: 'cus', kind: 'custom', title: 'Mine', variant: 'beta' },
  ];
  const cards = news.resolveFeed(feed, POSTS, { applyLocales: false });
  assert.deepEqual(cards.map((c) => c.title), ['B', 'C', 'Mine']);
  assert.deepEqual(cards[0].locales, { es: { excerpt: 'Hola' } });
  assert.equal(cards[2].variant, 'beta');
});

test('withSlot maps cards back to feed entries, skipping unmatched slots', () => {
  const feed = [{ kind: 'post', rule: { tag: 'Nope' } }, { kind: 'banner', imageUrl: 'https://x/y.png' }];
  assert.deepEqual(news.resolveFeed(feed, POSTS, { withSlot: true }).map((c) => c.slot), [1]);
});

test('checkNewsFeed flags bad slots', () => {
  const codes = checkNewsFeed({
    cards: [],
    feed: [
      { id: 'a', kind: 'post', rule: { tag: 'Campagin', index: 0 } },
      { id: 'a', kind: 'banner' },
      { id: 'c', kind: 'weird' },
      { id: 'd', kind: 'custom', variant: 'alpha' },
    ],
  }, ['Campaign', 'Update']).map((f) => f.code);
  assert.deepEqual(codes.sort(), ['news-banner-image', 'news-feed-dup', 'news-feed-index', 'news-feed-kind', 'news-feed-tag', 'news-feed-variant'].sort());
  assert.deepEqual(checkNewsFeed({ cards: [] }), []);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const defaults = require(path.join(__dirname, '../../frontend/js/video-reader/media-library-defaults.js'));

test('default podcasts come from image 1 and 2 catalogs', () => {
  assert.ok(defaults.PODCASTS.length >= 40);
  assert.equal(defaults.PODCASTS[0].title, 'Miss Honey: Slow English Podcast');
  assert.ok(defaults.PODCASTS.some((item) => item.title === 'Hidden Brain'));
});

test('default channels come from image 3 onward', () => {
  assert.ok(defaults.CHANNELS.length >= 30);
  assert.equal(defaults.CHANNELS[0].title, 'Listening Time');
  assert.ok(defaults.CHANNELS.some((item) => item.title === 'Kurzgesagt – In a Nutshell'));
  assert.ok(defaults.CHANNELS.some((item) => item.title === 'Peter Rabbit' && item.handle === 'OfficialPeterRabbit'));
});

test('podcast duplicate check matches feed url or title', () => {
  const list = defaults.buildPodcastDefaults().slice(0, 5);
  assert.ok(defaults.findPodcastDuplicate(list, { title: 'Spotlight English' }));
  assert.ok(defaults.findPodcastDuplicate(list, { feedUrl: list[0].feedUrl }));
  assert.equal(defaults.findPodcastDuplicate(list, { title: 'Brand New Show' }), null);
});

test('channel duplicate check matches handle or title', () => {
  const list = defaults.buildChannelDefaults().slice(0, 5);
  assert.ok(defaults.findChannelDuplicate(list, { title: 'Volka English' }));
  assert.ok(defaults.findChannelDuplicate(list, { handle: 'VolkaEnglish' }));
  assert.ok(defaults.findChannelDuplicate(list, { pageUrl: 'https://www.youtube.com/@VolkaEnglish' }));
  assert.equal(defaults.findChannelDuplicate(list, { title: 'Totally New Channel' }), null);
});

test('mergeDefaults keeps user items and skips duplicates', () => {
  const existing = [{
    feedUrl: 'https://example.com/feed.xml',
    title: 'Spotlight English',
  }];
  const merged = defaults.mergeDefaults(existing, defaults.buildPodcastDefaults(), 'feedUrl');
  assert.equal(merged[0].feedUrl, 'https://example.com/feed.xml');
  assert.equal(merged.filter((item) => item.title === 'Spotlight English').length, 1);
  assert.ok(merged.length > existing.length);
});

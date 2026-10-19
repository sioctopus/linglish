const test = require('node:test');
const assert = require('node:assert/strict');
const media = require('../services/media-library');

const YOUTUBE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <title>Volka English</title>
  <yt:channelId>UCexamplechannelid0000001</yt:channelId>
  <author><name>Volka English</name></author>
  <entry>
    <yt:videoId>abcdefghijk</yt:videoId>
    <title><![CDATA[Learn English &amp; Listen]]></title>
    <published>2026-10-13T00:00:00+00:00</published>
    <author><name>Volka English</name></author>
  </entry>
  <entry>
    <id>yt:video:zzz</id>
    <title>skip me</title>
  </entry>
</feed>`;

const PODCAST_RSS = `<?xml version="1.0"?>
<rss><channel>
  <title>Slow English Podcast</title>
  <itunes:author>Naysha</itunes:author>
  <description>Clear English stories.</description>
  <itunes:image href="https://cdn.example.com/show.jpg"/>
  <item>
    <title>Episode 3</title>
    <guid>ep-3</guid>
    <pubDate>Mon, 11 Oct 2026 00:00:00 GMT</pubDate>
    <itunes:duration>25:10</itunes:duration>
    <enclosure url="https://cdn.example.com/ep3.mp3" type="audio/mpeg"/>
    <podcast:transcript url="https://cdn.example.com/ep3.vtt" type="text/vtt"/>
    <description><![CDATA[<p>A short story.</p>]]></description>
  </item>
  <item><title>No audio</title></item>
</channel></rss>`;

test('proxy values become an agent url', () => {
  assert.equal(media.normalizeProxyServer('127.0.0.1:19828'), 'http://127.0.0.1:19828');
  assert.equal(
    media.normalizeProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7890'),
    'http://127.0.0.1:7890'
  );
  assert.equal(media.normalizeProxyServer(''), '');
});

test('channel links accept handles, ids, and full urls', () => {
  assert.equal(media.parseChannelInput('@VolkaEnglish').pageUrl, 'https://www.youtube.com/@VolkaEnglish');
  assert.equal(media.parseChannelInput('https://www.youtube.com/channel/UCexamplechannelid0000001').channelId, 'UCexamplechannelid0000001');
  assert.throws(() => media.parseChannelInput('https://example.com/@someone'), /YouTube/);
});

test('private feed urls are rejected', () => {
  assert.equal(media.isPrivateHostname('127.0.0.1'), true);
  assert.equal(media.isPrivateHostname('10.1.2.3'), true);
  assert.equal(media.isPrivateHostname('cdn.example.com'), false);
  assert.throws(() => media.assertPublicHttpUrl('http://169.254.169.254/latest'), /内网/);
  assert.throws(() => media.assertPublicHttpUrl('file:///etc/passwd'), /http/);
});

test('youtube rss keeps playable videos and decodes titles', () => {
  const feed = media.parseYouTubeRss(YOUTUBE_RSS);
  assert.equal(feed.title, 'Volka English');
  assert.equal(feed.channelId, 'UCexamplechannelid0000001');
  assert.equal(feed.videos.length, 1);
  assert.equal(feed.videos[0].title, 'Learn English & Listen');
  assert.equal(feed.videos[0].thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
});

test('podcast rss keeps audio episodes and transcript links', () => {
  const feed = media.parsePodcastRss(PODCAST_RSS);
  assert.equal(feed.title, 'Slow English Podcast');
  assert.equal(feed.author, 'Naysha');
  assert.equal(feed.image, 'https://cdn.example.com/show.jpg');
  assert.equal(feed.episodes.length, 1);
  assert.equal(feed.episodes[0].audioUrl, 'https://cdn.example.com/ep3.mp3');
  assert.equal(feed.episodes[0].transcriptUrl, 'https://cdn.example.com/ep3.vtt');
  assert.equal(feed.episodes[0].description, 'A short story.');
});

test('vtt cues become timed subtitle lines', () => {
  const cues = media.parseVtt(`WEBVTT

00:01.000 --> 00:03.500
Hello there.

00:04.000 --> 00:06.000
<c>And this just shows</c> you're engaged.`);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3.5);
  assert.equal(cues[1].text, "And this just shows you're engaged.");
});

test('itunes results only keep shows with a feed', () => {
  const shows = media.parseItunesResults({
    results: [
      { collectionId: 1, collectionName: 'Spotlight', artistName: 'Spotlight', feedUrl: 'https://example.com/feed', artworkUrl600: 'https://example.com/a.jpg' },
      { collectionId: 2, collectionName: 'Missing feed' },
    ],
  });
  assert.deepEqual(shows, [{
    id: '1',
    title: 'Spotlight',
    author: 'Spotlight',
    image: 'https://example.com/a.jpg',
    feedUrl: 'https://example.com/feed',
  }]);
});

test('channel page owner wins over a recommended channel', () => {
  const html = '{"channelId":"UCexamplechannelid0000002"} "externalId":"UCexamplechannelid0000001"';
  assert.equal(media.extractChannelId(html), 'UCexamplechannelid0000001');
});

test('channel pages can be identified from public html', () => {
  assert.equal(
    media.extractChannelId('<script>{"channelId":"UCexamplechannelid0000001"}</script>'),
    'UCexamplechannelid0000001'
  );
});

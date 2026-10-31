const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function youtubeWithMirrors(enabled) {
  const filename = path.resolve(__dirname, '../services/youtube.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const mirrorRequests = [];
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === 'child_process') return { execFile(_binary, _args, _options, callback) { callback(new Error('no yt-dlp')); } };
      if (name === '@danielxceron/youtube-transcript') return { YoutubeTranscript: { async fetchTranscript() { return [{ text: 'Direct YouTube captions.', offset: 0, duration: 2 }]; } } };
      if (name === './media-library') return { async fetchText(url) {
        mirrorRequests.push(url);
        return mirrorRequests.length % 2 === 1
          ? JSON.stringify([{ languageCode: 'en', url: '/captions.vtt' }])
          : 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nMirror captions.\n';
      } };
      return localRequire(name);
    },
    module, exports: module.exports, process: { env: { YOUTUBE_ENABLE_INNERTUBE: '0', YOUTUBE_ENABLE_MIRRORS: enabled } },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
  }, { filename });
  return { service: module.exports, mirrorRequests };
}

test('failed direct caption fetches do not disclose the video to mirrors by default', async () => {
  for (const enabled of [undefined, '0', 'false', 'true']) {
    const { service, mirrorRequests } = youtubeWithMirrors(enabled);
    const result = await service.getTranscript('abcdefghijk');
    assert.equal(result.source, 'web-scraping');
    assert.equal(result.transcript, 'Direct YouTube captions.');
    assert.equal(mirrorRequests.length, 0);
  }
});

test('an explicit operator opt-in permits caption mirror fallback', async () => {
  const { service, mirrorRequests } = youtubeWithMirrors('1');
  const result = await service.getTranscript('abcdefghijk');
  assert.equal(result.source, 'invidious:yewtu.be');
  assert.equal(result.transcript, 'Mirror captions.');
  assert.equal(mirrorRequests.length, 2);
});

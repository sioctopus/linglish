const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');

async function transcribeAs({ paid, localAvailable, mediaLibrary }) {
  let selectedProvider;
  let transcribed = false;
  let localChecks = 0;
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../routes/media-library.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === '../middleware/auth') return { authenticate: async () => ({ paid }) };
      if (name === '../services/entitlements') return { hasActivePaidEntitlement: user => user.paid };
      if (name === '../services/video-transcription') return { hasLocalWhisper: async () => { localChecks++; return localAvailable; } };
      if (name === '../services/media-library') return mediaLibrary || { async transcribePodcastBuffer(_buffer, options) {
        transcribed = true;
        selectedProvider = options.provider;
        return [{ text: 'Hello.', start: 0, end: 1 }];
      } };
      throw new Error(`Unexpected module: ${name}`);
    },
    module, exports: module.exports, Buffer,
  }, { filename });
  const req = Readable.from([Buffer.from('audio fixture')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/octet-stream' };
  const res = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  await module.exports.registerMediaLibraryRoutes('/media/transcribe', req, res);
  return { status: res.statusCode, body: res.body, selectedProvider, transcribed, localChecks };
}

test('paid podcast transcription does not force the free-tier local-only provider', async () => {
  for (const localAvailable of [false, true]) {
    const result = await transcribeAs({ paid: true, localAvailable });
    assert.equal(result.status, 200);
    assert.equal(result.transcribed, true);
    assert.equal(result.selectedProvider, undefined);
    assert.equal(result.localChecks, 0);
  }
});

test('free podcast transcription cannot reach cloud STT when local Whisper is unavailable', async () => {
  const result = await transcribeAs({ paid: false, localAvailable: false });
  assert.equal(result.status, 403);
  assert.equal(result.transcribed, false);
});

test('free podcast transcription selects only an available local Whisper runtime', async () => {
  const result = await transcribeAs({ paid: false, localAvailable: true });
  assert.equal(result.status, 200);
  assert.equal(result.selectedProvider, 'local-whisper');
});

test('podcast wrapper preserves local overload so the HTTP route responds with 503', async () => {
  const busy = Object.assign(new Error('本地 Whisper 正忙，请稍后重试'), { code: 'LOCAL_WHISPER_BUSY', status: 503 });
  const filename = path.resolve(__dirname, '../services/media-library.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === './video-transcription') return { async transcribeVideoFile() { throw busy; } };
      return localRequire(name);
    },
    module, exports: module.exports, __dirname: path.dirname(filename), process, Buffer, URL, console,
  }, { filename });
  const mediaLibrary = module.exports;
  await assert.rejects(mediaLibrary.transcribePodcastBuffer(Buffer.from([1]), { provider: 'local-whisper' }), error => error === busy);
  const result = await transcribeAs({ paid: false, localAvailable: true, mediaLibrary });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, '本地 Whisper 正忙，请稍后重试');
});

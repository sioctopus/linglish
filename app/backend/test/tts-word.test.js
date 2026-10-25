const test = require('node:test');
const assert = require('node:assert/strict');
const { wordRequest, registerTtsRoutes } = require('../routes/tts');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

test('word audio uses the agreed American female neural voice and trims input', () => {
  assert.equal(typeof wordRequest, 'function');
  assert.deepEqual(wordRequest(new URL('http://local/tts/word?text=%20elephant%20&voice=other')), {
    text: 'elephant', voice: 'en-US-AvaMultilingualNeural',
  });
});

test('word audio follows a caller-selected practice voice', () => {
  assert.deepEqual(wordRequest(new URL('http://local/tts/word?text=elephant&voice=en-GB-RyanNeural')), {
    text: 'elephant', voice: 'en-GB-RyanNeural',
  });
});

test('word audio rejects empty, oversized and non-word payloads', () => {
  assert.equal(typeof wordRequest, 'function');
  for (const text of ['', ' ', '...', 'a'.repeat(181), '<script>alert(1)</script>']) {
    assert.throws(() => wordRequest(new URL('http://local/tts/word?text=' + encodeURIComponent(text))), { statusCode: 400 });
  }
});

test('word audio is cached by the browser and missing audio errors are not cached', async (t) => {
  const service = require('../services/tts');
  const previous = service.textToSpeech;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linglish-word-route-'));
  const file = path.join(dir, 'voice.mp3');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(256)]));
  let missing = false;
  service.textToSpeech = async () => missing ? path.join(dir, 'missing.mp3') : file;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    registerTtsRoutes('/tts/word', req, res, new URL(req.url, 'http://local')).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    service.textToSpeech = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/tts/word?text=elephant&v=ava1';
  const response = await fetch(url);
  await response.arrayBuffer();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-tts-voice'), 'en-US-AvaMultilingualNeural');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=604800');
  missing = true;
  const failed = await fetch(url);
  await failed.text();
  assert.equal(failed.status, 404);
  assert.match(failed.headers.get('cache-control'), /no-store/);
});

test('a neural-only request reports an outage instead of substituting the Google voice', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linglish-neural-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let googleRequests = 0;
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../services/tts.js'), 'utf8');
  vm.runInNewContext(source, {
    module, __dirname: path.join(dir, 'services'), process, URL,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => { fn(); },
    require(name) {
      if (name === 'fs') return { ...fs, createWriteStream: () => ({ close() {} }) };
      if (name === 'child_process') return { execFile: (cmd, args, options, callback) => callback(new Error('upstream unavailable')) };
      if (name === 'https') return { get() { googleRequests++; throw new Error('Google voice must not be substituted'); } };
      return require(name);
    },
  });
  await assert.rejects(module.exports.textToSpeech('elephant', { provider: 'edge', allowFallback: false }), { statusCode: 503 });
  assert.equal(googleRequests, 0);
});

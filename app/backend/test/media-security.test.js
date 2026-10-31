const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const zlib = require('node:zlib');

function loadMedia({ addresses = [{ address: '93.184.216.34', family: 4 }], respond = callback => response(callback, 'ok'), transcript, download } = {}) {
  const calls = [];
  const transport = {
    get(url, options, callback) {
      const request = new EventEmitter();
      request.destroy = () => {};
      calls.push({ url, options });
      if (respond) process.nextTick(() => respond(callback, calls.length));
      return request;
    },
  };
  const filename = path.join(__dirname, '../services/media-library.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === 'http' || name === 'https') return transport;
      if (name === 'dns') return { promises: { lookup: async () => addresses } };
      if (name === './youtube') return { getTranscript: async () => transcript };
      if (name === 'child_process' && download) return { execFile: download };
      return require(name);
    },
    module, exports: module.exports, Buffer, URL, console, setTimeout, clearTimeout,
    process: { env: {}, platform: process.platform },
  }, { filename });
  return { media: module.exports, calls };
}

function response(callback, body, headers = {}, statusCode = 200) {
  const res = new PassThrough();
  res.headers = headers;
  res.statusCode = statusCode;
  callback(res);
  res.end(body);
}

test('media fetch rejects DNS names resolving to loopback before connecting', async () => {
  const { media, calls } = loadMedia({ addresses: [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(async () => media.fetchBytes('http://public.example/captions'), /内网/);
  assert.equal(calls.length, 0);
});

test('media fetch rejects mapped IPv6 and URL credentials', async () => {
  const { media, calls } = loadMedia();
  for (const url of ['http://[::ffff:127.0.0.1]/', 'https://user:password@public.example/']) {
    await assert.rejects(async () => media.fetchBytes(url), /内网|凭据/);
  }
  assert.equal(calls.length, 0);
});

test('media fetch pins a validated public DNS address and decodes bounded gzip', async () => {
  const { media, calls } = loadMedia({
    respond: callback => response(callback, zlib.gzipSync('WEBVTT\n\nhello'), { 'content-encoding': 'gzip' }),
  });
  const body = await media.fetchBytes('https://public.example/captions');
  assert.equal(body.toString(), 'WEBVTT\n\nhello');
  assert.equal(calls[0].options.agent, false);
  assert.equal(calls[0].options.autoSelectFamily, false);
  let address;
  calls[0].options.lookup('public.example', {}, (_error, value) => { address = value; });
  assert.equal(address, '93.184.216.34');
});

test('media fetch bounds decoded data and checks redirect destinations', async () => {
  const large = loadMedia({
    respond: callback => response(callback, zlib.gzipSync('x'.repeat(1000)), { 'content-encoding': 'gzip' }),
  });
  await assert.rejects(large.media.fetchBytes('https://public.example/', { maxBytes: 100 }), /过大/);
  const redirect = loadMedia({
    respond: callback => response(callback, '', { location: 'http://[::ffff:127.0.0.1]/' }, 302),
  });
  await assert.rejects(redirect.media.fetchBytes('https://public.example/'), /内网/);
  assert.equal(redirect.calls.length, 1);
});

test('media fetch has a total deadline even when a connection makes no progress', async () => {
  const { media } = loadMedia({ respond() {} });
  const result = await Promise.race([
    Promise.resolve(media.fetchBytes('https://public.example/', { timeoutMs: 20 })).then(() => 'success', error => error.message),
    new Promise(resolve => setTimeout(() => resolve('deadline missing'), 150)),
  ]);
  assert.match(result, /超时/);
});

function loadRoute(authenticate, mediaLibrary = {}) {
  const filename = path.join(__dirname, '../routes/media-library.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === '../services/media-library') return mediaLibrary;
      if (name === '../middleware/auth') return { authenticate };
      if (name === '../services/entitlements') return { hasActivePaidEntitlement: user => user.paid === true };
      if (name === '../services/video-transcription') return { hasLocalWhisper: async () => false };
      return require(name);
    },
    module, exports: module.exports, Buffer,
  }, { filename });
  return module.exports.registerMediaLibraryRoutes;
}

async function routeRequest(route, pathname, body, headers = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.headers = headers;
  const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await route(pathname, req, res);
  return res;
}

test('all media routes authenticate before dispatching or reading their body', async () => {
  const route = loadRoute(async () => { throw new Error('UNAUTHORIZED'); });
  for (const pathname of ['/media/channels/preview', '/media/podcasts/search', '/media/podcasts/preview', '/media/cues', '/media/covers/resolve']) {
    const res = await routeRequest(route, pathname, '{}');
    assert.equal(res.statusCode, 401, pathname);
  }
});

test('media JSON requests reject malformed and oversized payloads', async () => {
  const route = loadRoute(async () => ({}));
  assert.equal((await routeRequest(route, '/media/cues', '{')).statusCode, 400);
  assert.equal((await routeRequest(route, '/media/cues', 'x'.repeat(32769))).statusCode, 413);
});

test('a free subtitle resolver cannot invoke paid cloud audio transcription', async () => {
  let input;
  const route = loadRoute(async () => ({}), {
    async resolveMediaCues(value) { input = value; return { cues: [] }; },
  });
  await routeRequest(route, '/media/resolve-cues', JSON.stringify({ audioUrl: 'https://public.example/audio.mp3' }));
  assert.equal(input.allowAudioStt, false);
});

test('YouTube caption resolver reads the transcript service segments without an STT fallback', async () => {
  const { media } = loadMedia({ transcript: { success: true, segments: [{ start: 1, end: 3, text: 'Hello.' }] } });
  const result = await media.resolveMediaCues({ youtubeVideoId: 'abcdefghijk', allowAudioStt: false });
  assert.equal(result.source, 'youtube-captions');
  assert.equal(result.cues[0].text, 'Hello.');
});

test('unpaid caption-only resolution never fetches an audio URL', async () => {
  const { media, calls } = loadMedia();
  await assert.rejects(media.resolveMediaCues({ audioUrl: 'https://public.example/audio.mp3', allowAudioStt: false }), /没有可用字幕/);
  assert.equal(calls.length, 0);
});

test('failed YouTube audio downloads remove partial files from their private temporary directory', async () => {
  let partial;
  const { media } = loadMedia({ download(_command, args, _options, callback) {
    partial = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp3') + '.part';
    fs.writeFileSync(partial, 'disposable fixture');
    callback(new Error('download failed'), '', 'download failed');
  } });
  try {
    await assert.rejects(media.transcribeYoutubeAudio('abcdefghijk'), /download failed/);
    assert.equal(fs.existsSync(partial), false);
  } finally {
    if (partial) fs.rmSync(partial, { force: true });
  }
});

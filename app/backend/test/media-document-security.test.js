const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const media = require('../services/media-library');
const reading = require('../services/reading-subtitles');

async function canary(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (handler) return handler(req, res);
    res.end('WEBVTT\n\n00:00.000 --> 00:01.000\nPrivate canary.');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { hits, port: server.address().port };
}

function localDns(t, records) {
  const original = dns.lookup;
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    if (hostname !== 'media-fixture.example') return original(hostname, options, callback);
    if (typeof options === 'function') callback = options;
    if (options && options.all) process.nextTick(callback, null, [{ address: '127.0.0.1', family: 4 }]);
    else process.nextTick(callback, null, '127.0.0.1', 4);
  });
  t.mock.method(dns.promises, 'lookup', async hostname => {
    assert.equal(hostname, 'media-fixture.example');
    return records;
  });
}

test('mapped IPv6 transcript URLs cannot read a loopback HTTP service', async t => {
  const local = await canary(t);
  await assert.rejects(
    () => media.loadTranscriptCues(`http://[::ffff:127.0.0.1]:${local.port}/private`),
    /内网/
  );
  assert.deepEqual(local.hits, []);
});

test('DNS-resolved private addresses cannot read a loopback HTTP service', async t => {
  const local = await canary(t);
  localDns(t, [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(
    () => media.loadTranscriptCues(`http://media-fixture.example:${local.port}/private`),
    /内网/
  );
  assert.deepEqual(local.hits, []);
});

test('a public DNS answer cannot hide a second private or mapped answer', async t => {
  const local = await canary(t);
  localDns(t, [{ address: '8.8.8.8', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }]);
  await assert.rejects(
    () => media.loadTranscriptCues(`http://media-fixture.example:${local.port}/private`),
    /内网/
  );
  assert.deepEqual(local.hits, []);
});

test('non-public literal IP ranges and userinfo are refused', () => {
  for (const address of [
    '0.1.2.3', '100.64.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1',
    '198.19.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '[::]', '[::1]', '[::ffff:8.8.8.8]', '[64:ff9b::7f00:1]', '[fc00::1]',
    '[fe80::1]', '[ff02::1]', '[2001:db8::1]', '[2002:7f00:1::]', '[3fff::1]',
  ]) assert.throws(() => media.assertPublicHttpUrl(`http://${address}/`), /内网/, address);
  assert.throws(() => media.assertPublicHttpUrl('http://name:password@example.com/'), /凭据/);
  assert.equal(media.assertPublicHttpUrl('https://[2606:4700:4700::1111]/').protocol, 'https:');
});

// Route the verified public address to a real local fixture server. DNS after
// validation deliberately changes to loopback, so a second lookup reaches a
// different canary instead of the simulated public origin.
async function publicOrigin(t, handler) {
  const origin = await canary(t, handler);
  const privateService = await canary(t);
  const originalGet = http.get;
  const originalLookup = dns.lookup;
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    if (hostname !== 'media-fixture.example') return originalLookup(hostname, options, callback);
    if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  });
  t.mock.method(http, 'get', (url, options, onResponse) => {
    if (url.hostname !== 'media-fixture.example') return originalGet(url, options, onResponse);
    const request = { ...options, hostname: '127.0.0.1', port: origin.port, path: url.pathname, family: 4, lookup: undefined };
    const lookup = options.lookup || dns.lookup;
    let resolved;
    lookup(url.hostname, {}, (error, address) => { assert.ifError(error); resolved = address; });
    if (resolved !== '8.8.8.8') request.port = privateService.port;
    return originalGet(request, onResponse);
  });
  return { origin, privateService, url: 'http://media-fixture.example/transcript' };
}

test('a DNS change after validation cannot redirect the connection to loopback', async t => {
  const fixture = await publicOrigin(t, (_req, res) => res.end('WEBVTT\n\n00:00.000 --> 00:01.000\nPublic origin.'));
  const cues = await media.loadTranscriptCues(fixture.url);
  assert.deepEqual(cues, [{ start: 0, end: 1, text: 'Public origin.' }]);
  assert.deepEqual(fixture.privateService.hits, []);
});

test('redirect destinations are checked before a private target is contacted', async t => {
  const target = await canary(t);
  const fixture = await publicOrigin(t, (_req, res) => {
    res.writeHead(302, { Location: `http://[::ffff:127.0.0.1]:${target.port}/private` });
    res.end();
  });
  await assert.rejects(() => media.loadTranscriptCues(fixture.url), /内网/);
  assert.deepEqual(target.hits, []);
});

test('an invalid redirect URL becomes a request failure instead of an uncaught exception', async t => {
  const fixture = await publicOrigin(t, (_req, res) => {
    res.writeHead(302, { Location: 'http://[' });
    res.end();
  });
  await assert.rejects(() => media.fetchText(fixture.url, { timeoutMs: 30 }), /链接无效/);
});

test('outbound proxy configuration cannot forward a protected fetch', async t => {
  const proxy = await canary(t);
  const fixture = await publicOrigin(t, (_req, res) => res.end('Public origin.'));
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = proxyUrl;
  t.after(() => {
    if (previous == null) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  });
  assert.equal(await media.fetchText(fixture.url), 'Public origin.');
  assert.deepEqual(proxy.hits, []);
});

test('a remote body cannot exceed the requested download limit', async t => {
  const fixture = await publicOrigin(t, (_req, res) => {
    res.write('a'.repeat(128));
    res.end('a'.repeat(128));
  });
  await assert.rejects(() => media.fetchText(fixture.url, { maxBytes: 64 }), /过大/);
});

test('a slow trickle cannot keep a remote download alive beyond the total deadline', async t => {
  const fixture = await publicOrigin(t, (_req, res) => {
    res.writeHead(200);
    res.write('a');
    const timer = setInterval(() => res.write('a'), 5);
    res.on('close', () => clearInterval(timer));
  });
  await assert.rejects(() => media.fetchText(fixture.url, { timeoutMs: 40 }), /超时/);
});

test('a stalled DNS lookup obeys the same request deadline', async t => {
  t.mock.method(dns.promises, 'lookup', () => new Promise(() => {}));
  await assert.rejects(() => media.fetchText('http://media-fixture.example/', { timeoutMs: 20 }), /超时/);
});

test('an interrupted remote response fails instead of leaving the route pending', async t => {
  const fixture = await publicOrigin(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': '500' });
    res.write('partial');
    setImmediate(() => res.destroy());
  });
  await assert.rejects(() => media.fetchText(fixture.url), /网络请求失败/);
});

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const body = entry.raw || zlib.deflateRawSync(data);
    const size = entry.declaredSize == null ? data.length : entry.declaredSize;
    const head = Buffer.alloc(30 + name.length);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(size, 22);
    head.writeUInt16LE(name.length, 26);
    name.copy(head, 30);
    locals.push(head, body);
    const record = Buffer.alloc(46 + name.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    name.copy(record, 46);
    central.push(record);
    offset += head.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('compressed document expansion is bounded even when its declared size lies', () => {
  const archive = zip([{ name: 'word/document.xml', data: Buffer.alloc(8 * 1024 * 1024 + 1, 65), declaredSize: 1 }]);
  assert.throws(() => reading.extractDocxText(archive), /过大|上限/);
});

test('ZIP entry count has a hard limit', () => {
  const many = zip(Array.from({ length: 2049 }, (_, i) => ({ name: `chapter-${i}.html`, data: '<body>Hello class.</body>' })));
  assert.throws(() => reading.extractEpubText(many), /数量|过多|上限/);
});

test('ZIP cumulative expanded text has a hard limit', () => {
  const large = zip(Array.from({ length: 5 }, (_, i) => ({ name: `chapter-${i}.html`, data: Buffer.alloc(7 * 1024 * 1024, 65) })));
  assert.throws(() => reading.extractEpubText(large), /过大|上限/);
});

test('DOCX and EPUB ignore compressed binary members instead of inflating them', () => {
  const brokenImage = { name: 'media/image.png', raw: Buffer.from('invalid compressed binary') };
  assert.equal(reading.extractDocxText(zip([
    { name: 'word/document.xml', data: '<w:p><w:t>Hello class.</w:t></w:p>' }, brokenImage,
  ])).trim(), 'Hello class.');
  assert.match(reading.extractEpubText(zip([
    { name: 'Text/chapter.xhtml', data: '<html><head><title>Ignore metadata</title></head><body>Hello class.</body></html>' }, brokenImage,
  ])), /Hello class\./);
});

test('an EPUB empty body does not become a lesson made from its metadata', () => {
  const archive = zip([{ name: 'Text/chapter.xhtml', data: '<html><head><title>Metadata only.</title></head><body></body></html>' }]);
  assert.throws(() => reading.extractEpubText(archive), /没有可读取的正文/);
});

test('truncated ZIP data is rejected instead of returning a partial lesson', () => {
  const archive = zip([
    { name: 'word/document.xml', data: '<w:t>Hello class.</w:t>' },
    { name: 'other.xml', data: '<data />' },
  ]);
  const directoryStart = archive.readUInt32LE(archive.length - 22 + 16);
  archive.writeUInt32LE(0, directoryStart + 46 + Buffer.byteLength('word/document.xml'));
  assert.throws(() => reading.extractDocxText(archive), /压缩|文档/);
});

function response() {
  return {
    headersSent: false, writableEnded: false,
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(body) { this.body = body; this.writableEnded = true; },
  };
}

test('media fetch routes reject anonymous callers before fetching a supplied URL', async t => {
  const local = await canary(t);
  const { registerMediaLibraryRoutes } = require('../routes/media-library');
  for (const path of ['/media/cues', '/media/podcasts/preview', '/media/podcasts/search', '/media/channels/preview']) {
    const req = Readable.from([JSON.stringify({ url: `http://[::ffff:127.0.0.1]:${local.port}/private`, query: 'news' })]);
    req.method = 'POST';
    req.headers = {};
    const res = response();
    assert.equal(await registerMediaLibraryRoutes(path, req, res), true);
    assert.equal(res.statusCode, 401, path);
  }
  assert.deepEqual(local.hits, []);
});

test('media routes reject oversized JSON for an authenticated caller', async t => {
  const auth = require('../services/auth');
  t.mock.method(auth, 'requireUser', async () => ({ id: 1 }));
  const { registerMediaLibraryRoutes } = require('../routes/media-library');
  const req = Readable.from([JSON.stringify({ query: 'a'.repeat(40 * 1024) })]);
  req.method = 'POST';
  req.headers = { authorization: 'Bearer fixture' };
  const res = response();
  assert.equal(await registerMediaLibraryRoutes('/media/podcasts/search', req, res), true);
  assert.equal(res.statusCode, 413);
});

test('oversized chunked HTTP bodies receive a 413 response without resetting the connection', async t => {
  const auth = require('../services/auth');
  t.mock.method(auth, 'requireUser', async () => ({ id: 1 }));
  const { registerMediaLibraryRoutes } = require('../routes/media-library');
  const local = await canary(t, (req, res) => {
    registerMediaLibraryRoutes('/media/podcasts/search', req, res).catch(error => res.destroy(error));
  });
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: local.port, path: '/', method: 'POST',
      headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('{"query":"');
    req.end(`${'a'.repeat(40 * 1024)}"}`);
  });
  assert.equal(status, 413);
});

test('legacy PDF import endpoints remain unavailable without parsing a server file path', async () => {
  const { registerPdfRoutes } = require('../routes/pdf');
  for (const path of ['/pdf/import', '/pdf/upload']) {
    const req = Readable.from([JSON.stringify({ pdfPath: '/private/canary.pdf' })]);
    req.method = 'POST';
    req.headers = {};
    const res = response();
    assert.equal(await registerPdfRoutes(path, req, res), false);
    assert.equal(res.headersSent, false);
  }
});

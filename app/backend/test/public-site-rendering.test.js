const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');

// A domain shared with the template plus a port catches cascading replacements.
process.env.SITE_URL = 'https://example.com:4444';
const { registerStaticRoutes } = require('../routes/static');

test('configured metadata origin is substituted once, with valid inline scripts and HEAD length', async (t) => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!await registerStaticRoutes(url.pathname, req, res, url)) {
        res.writeHead(404);
        res.end();
      }
    } catch (_) {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const pathname of ['/practice-session.html', '/practice-session-desktop.html', '/learning-reports.html']) {
    const get = await fetch(origin + pathname);
    const html = await get.text();
    assert.equal(get.status, 200);
    assert.ok(html.includes('https://example.com:4444'));
    assert.doesNotMatch(html, /:4444:4444|https:\/\/www\.example\.com/);
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=|application\/ld\+json|type=["']module["']/i.test(match[1])) continue;
      if (match[2].trim()) new vm.Script(match[2]);
    }
    const head = await fetch(origin + pathname, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(html)));
    assert.equal(await head.text(), '');
  }
});

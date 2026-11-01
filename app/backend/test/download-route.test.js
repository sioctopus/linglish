const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.SITE_URL = 'https://download.example.test';
const { registerStaticRoutes } = require('../routes/static');
const { registerSeoRoutes } = require('../routes/seo');

test('the public download URL supports canonical navigation, anonymous GET and HEAD', async (t) => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (await registerSeoRoutes(url.pathname, req, res, url)) return;
      if (await registerStaticRoutes(url.pathname, req, res, url)) return;
      res.writeHead(404); res.end();
    } catch (_) { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const legacy = await fetch(origin + '/download.html?from=homepage', { redirect: 'manual' });
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get('location'), '/download?from=homepage');
  const response = await fetch(origin + '/download');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('x-robots-tag'), null);
  assert.match(html, /rel="canonical"[^>]*href="https:\/\/download\.example\.test\/download"/);
  assert.doesNotMatch(html, /(?:auth-manager|guest-check)\.js/);
  assert.doesNotMatch(html, /install-desktop\.js/);
  const head = await fetch(origin + '/download', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(html)));
  assert.equal(await head.text(), '');
  const sitemap = await fetch(origin + '/sitemap-main.xml');
  assert.equal(sitemap.status, 200);
  assert.match(await sitemap.text(), /<loc>https:\/\/download\.example\.test\/download<\/loc>/);
});

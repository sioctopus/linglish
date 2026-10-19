const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');

// Exercise deployed canonicals with an explicit fictional site configuration.
process.env.SITE_URL = 'https://www.example.com';
const { registerSeoRoutes } = require('../routes/seo');
const { registerStaticRoutes } = require('../routes/static');
const dataStore = require('../data-store');

async function startSeoServer(t) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (await registerSeoRoutes(pathname, req, res, url)) return;
      if (await registerStaticRoutes(pathname, req, res, url)) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error.stack || error.message);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('root serves the indexable product landing page on the canonical www URL', async (t) => {
  const base = await startSeoServer(t);
  const response = await fetch(`${base}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(html, /<h1[^>]*>Linglish<\/h1>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.example\.com\/">/);
  assert.match(html, /"@type":\s*"FAQPage"/);
  const redirectStart = html.indexOf('if (readToken() && !isGuestSession(readToken())) {');
  const redirectEnd = html.indexOf("document.getElementById('account-logout')", redirectStart);
  assert.ok(redirectStart >= 0 && redirectEnd > redirectStart, 'account redirect must be conditional');
  const destinations = [];
  const accountRedirect = html.slice(redirectStart, redirectEnd);
  for (const token of [null, 'guest-token']) {
    vm.runInNewContext(accountRedirect, {
      readToken: () => token,
      isGuestSession: () => token === 'guest-token',
      isMobile: () => false,
      renderLoggedInAccount: () => {},
      window: { location: { replace: destination => destinations.push(destination) } },
    });
  }
  assert.deepEqual(destinations, [], 'anonymous and guest visitors must stay on the indexable landing page');
});

test('legacy landing URL redirects permanently to the canonical root', async (t) => {
  const base = await startSeoServer(t);
  const response = await fetch(`${base}/landing.html?from=legacy`, { redirect: 'manual' });

  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), '/?from=legacy');
});

test('discovery endpoints and clean public landing routes support HEAD without a body', async (t) => {
  const base = await startSeoServer(t);
  for (const pathname of ['/', '/robots.txt', '/sitemap.xml', '/llms.txt', '/learn/videos', '/interview', '/workplace', '/shadowing']) {
    const response = await fetch(`${base}${pathname}`, { method: 'HEAD' });
    assert.equal(response.status, 200, `${pathname} should support HEAD`);
    assert.equal(await response.text(), '', `${pathname} HEAD response should be empty`);
  }
});

test('clean public landing routes use www canonicals and redirect duplicate html URLs', async (t) => {
  const base = await startSeoServer(t);
  for (const slug of ['interview', 'workplace', 'shadowing']) {
    const response = await fetch(`${base}/${slug}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, new RegExp(`<link rel="canonical" href="https:\\/\\/www\\.example\\.com\\/${slug}">`));

    const duplicate = await fetch(`${base}/${slug}.html`, { redirect: 'manual' });
    assert.equal(duplicate.status, 301);
    assert.equal(duplicate.headers.get('location'), `/${slug}`);
  }
});

test('robots explicitly permits AI search discovery and publishes the www sitemap', async (t) => {
  const base = await startSeoServer(t);
  const response = await fetch(`${base}/robots.txt`);
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /User-agent: OAI-SearchBot\nAllow: \//);
  assert.match(text, /Sitemap: https:\/\/www\.example\.com\/sitemap\.xml/);
  assert.match(text, /# AI content guide: https:\/\/www\.example\.com\/llms\.txt/);

  const oaiGroup = text.split('User-agent: OAI-SearchBot\n')[1].split('\nUser-agent:')[0];
  assert.match(oaiGroup, /Disallow: \/recordings\//);
  assert.match(oaiGroup, /Disallow: \/tts-audio\//);
  assert.match(oaiGroup, /Disallow: \/admin/);
});

test('main sitemap lists canonical public landing and learning resources only', async (t) => {
  const base = await startSeoServer(t);
  const response = await fetch(`${base}/sitemap-main.xml`);
  const xml = await response.text();

  assert.equal(response.status, 200);
  for (const pathname of ['/', '/interview', '/workplace', '/shadowing', '/pricing.html', '/learn/videos', '/learn/words']) {
    assert.match(xml, new RegExp(`<loc>https:\\/\\/www\\.example\\.com${pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>`));
  }
  assert.doesNotMatch(xml, /index-desktop\.html|today\.html|login\.html/);
  assert.doesNotMatch(xml, /<loc>https:\/\/example\.com/);
  assert.doesNotMatch(xml, /<lastmod>/, 'static pages should not claim a new modification date on every request');
});

test('llms description uses current capabilities without unsupported inventory claims', async (t) => {
  const base = await startSeoServer(t);
  const response = await fetch(`${base}/llms.txt`);
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /Canonical website: https:\/\/www\.example\.com\//);
  assert.match(text, /AI-assisted daily plan/);
  assert.match(text, /AI speech feedback/);
  for (const word of ['meeting', 'the', 'and', 'have']) {
    assert.match(text, new RegExp(`https:\\/\\/www\\.example\\.com\\/learn\\/word\\/${word}(?:\\s|$)`));
  }
  assert.doesNotMatch(text, /300\+|10,000\+|free, no ads/i);
});

test('public SSR pages advertise the AI-readable site guide', async (t) => {
  const originalQuery = dataStore.query;
  dataStore.query = async () => ({
    rows: [{
      id: 1,
      word: 'meeting',
      word_lowercase: 'meeting',
      phonetic: 'ˈmiːtɪŋ',
      definitions: [{ definition: 'An occasion when people come together.' }],
      part_of_speech: 'noun',
      frequency_rank: 500,
      difficulty_level: 'beginner',
      example_sentences: [],
      synonyms: [],
      content_revision: 3,
      phonetic_source: 'batch_verified',
      definitions_source: 'batch_verified',
      part_of_speech_source: 'batch_verified',
      quality_status: 'verified',
      quality_score: 100,
      quality_reasons: [],
      quality_checked_revision: 3,
      quality_checked_at: '2026-08-22T00:00:00.000Z',
      seo_indexable: true,
    }],
  });
  t.after(() => { dataStore.query = originalQuery; });

  const base = await startSeoServer(t);
  const html = await (await fetch(`${base}/learn/word/meeting`)).text();

  assert.match(
    html,
    /<link rel="alternate" type="text\/plain" href="https:\/\/www\.example\.com\/llms\.txt" title="Linglish AI content guide">/
  );
});

test('interactive app shells are noindex while public pricing stays indexable', async (t) => {
  const base = await startSeoServer(t);
  const appResponse = await fetch(`${base}/today.html`);
  const pricingResponse = await fetch(`${base}/pricing.html`);

  assert.equal(appResponse.status, 200);
  assert.equal(appResponse.headers.get('x-robots-tag'), 'noindex, follow');
  assert.equal(pricingResponse.status, 200);
  assert.equal(pricingResponse.headers.get('x-robots-tag'), null);
});

test('HEAD keeps the same 404 status as GET for missing dynamic detail pages', async (t) => {
  const originalQuery = dataStore.query;
  dataStore.query = async () => ({ rows: [] });
  t.after(() => {
    dataStore.query = originalQuery;
  });
  const base = await startSeoServer(t);

  for (const pathname of ['/learn/video/999999999', '/learn/word/not-present']) {
    const getResponse = await fetch(`${base}${pathname}`);
    const headResponse = await fetch(`${base}${pathname}`, { method: 'HEAD' });
    assert.equal(getResponse.status, 404);
    assert.equal(headResponse.status, getResponse.status, `${pathname} HEAD should match GET`);
    assert.equal(await headResponse.text(), '');
  }
});

test('word detail, list, and sitemap share the current verified SEO eligibility gate', async (t) => {
  const originalQuery = dataStore.query;
  const meeting = {
    id: 1,
    word: 'meeting',
    word_lowercase: 'meeting',
    phonetic: 'ˈmiːtɪŋ',
    definitions: [{ definition: 'An occasion when people come together.' }],
    part_of_speech: 'noun',
    frequency_rank: 500,
    difficulty_level: 'beginner',
    example_sentences: [],
    synonyms: [],
    content_revision: 3,
    phonetic_source: 'batch_verified',
    definitions_source: 'batch_verified',
    part_of_speech_source: 'batch_verified',
    quality_status: 'verified',
    quality_score: 100,
    quality_reasons: [],
    quality_checked_revision: 3,
    quality_checked_at: '2026-08-22T00:00:00.000Z',
    seo_indexable: true,
  };
  const review = {
    ...meeting,
    id: 2,
    word: 'draftword',
    word_lowercase: 'draftword',
    quality_status: 'review',
    quality_checked_revision: null,
    quality_checked_at: null,
    seo_indexable: false,
  };

  dataStore.query = async (sql, params = []) => {
    if (/FROM words WHERE word_lowercase = \$1/.test(sql)) {
      return { rows: [params[0] === 'meeting' ? meeting : review] };
    }
    if (/SELECT COUNT\(\*\) FROM words/.test(sql)) {
      assert.match(sql, /seo_indexable\s*=\s*(?:TRUE|true)/);
      assert.match(sql, /quality_status\s*=\s*'verified'/);
      assert.match(sql, /dictionary_word_is_seo_eligible\(words\)/);
      return { rows: [{ count: '1' }] };
    }
    if (/SELECT id, word, part_of_speech/.test(sql)) {
      assert.match(sql, /seo_indexable\s*=\s*(?:TRUE|true)/);
      assert.match(sql, /quality_status\s*=\s*'verified'/);
      assert.match(sql, /dictionary_word_is_seo_eligible\(words\)/);
      return { rows: [meeting] };
    }
    if (/SELECT word, updated_at FROM words/.test(sql)) {
      assert.match(sql, /seo_indexable\s*=\s*(?:TRUE|true)/);
      assert.match(sql, /quality_status\s*=\s*'verified'/);
      assert.match(sql, /dictionary_word_is_seo_eligible\(words\)/);
      return { rows: [{ word: 'meeting', updated_at: '2026-08-22T00:00:00.000Z' }] };
    }
    throw new Error(`Unexpected SEO query: ${sql}`);
  };
  t.after(() => { dataStore.query = originalQuery; });
  const base = await startSeoServer(t);

  const indexableResponse = await fetch(`${base}/learn/word/meeting`);
  const indexableHtml = await indexableResponse.text();
  assert.equal(indexableResponse.headers.get('x-robots-tag'), null);
  assert.match(indexableHtml, /application\/ld\+json/);

  const reviewResponse = await fetch(`${base}/learn/word/draftword`);
  const reviewHtml = await reviewResponse.text();
  assert.equal(reviewResponse.status, 200);
  assert.equal(reviewResponse.headers.get('x-robots-tag'), 'noindex, follow');
  assert.match(reviewHtml, /<meta name="robots" content="noindex, follow">/);
  assert.doesNotMatch(reviewHtml, /application\/ld\+json/);

  const listHtml = await (await fetch(`${base}/learn/words`)).text();
  assert.match(listHtml, /meeting/);
  assert.doesNotMatch(listHtml, /draftword/);

  const sitemapXml = await (await fetch(`${base}/sitemap-words.xml`)).text();
  assert.match(sitemapXml, /\/learn\/word\/meeting/);
  assert.doesNotMatch(sitemapXml, /draftword/);
});

test('word sitemap reports the stored update date and omits invented dates', async (t) => {
  const originalQuery = dataStore.query;
  dataStore.query = async (sql) => {
    assert.match(sql, /SELECT word, updated_at FROM words/);
    assert.match(sql, /seo_indexable\s*=\s*(?:TRUE|true)/);
    return {
      rows: [
        { word: 'meeting', updated_at: '2026-08-22T03:15:00.000Z' },
        { word: 'the', updated_at: null },
      ],
    };
  };
  t.after(() => { dataStore.query = originalQuery; });

  const base = await startSeoServer(t);
  const xml = await (await fetch(`${base}/sitemap-words.xml`)).text();

  assert.match(xml, /<loc>https:\/\/www\.example\.com\/learn\/word\/meeting<\/loc>\s*<lastmod>2026-08-22<\/lastmod>/);
  assert.match(xml, /<loc>https:\/\/www\.example\.com\/learn\/word\/the<\/loc>\s*<changefreq>monthly<\/changefreq>/);
  assert.doesNotMatch(xml, /<loc>https:\/\/www\.example\.com\/learn\/word\/the<\/loc>\s*<lastmod>/);
});

test('homepage social image has a matching JPEG URL, MIME type and file signature', async (t) => {
  const base = await startSeoServer(t);
  const html = await (await fetch(`${base}/`)).text();
  const imageUrl = html.match(/<meta property="og:image" content="([^"]+)">/)?.[1];
  assert.ok(imageUrl, 'homepage should publish an Open Graph image');

  const imagePath = new URL(imageUrl).pathname;
  assert.match(imagePath, /\.jpg$/);
  const imageResponse = await fetch(`${base}${imagePath}`);
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  assert.match(imageResponse.headers.get('content-type'), /^image\/jpeg/);
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xff, 0xd8, 0xff]);
});

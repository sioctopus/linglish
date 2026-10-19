const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

let containerName;
let available = false;
let core;
let store;
let workbench;
let ensurePrivacy;
let server;
let baseUrl;
const createdFiles = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function request(urlPath, token, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    if (body) headers['content-type'] = 'application/json';
    const req = http.request(`${baseUrl}${urlPath}`, { method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json; try { json = JSON.parse(text); } catch (_) { /* binary fixture */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function initializeSchema(query) {
  const v1 = await fs.readFile(path.resolve(__dirname, '../../../docs/db/migrations/V1__initial_schema.sql'), 'utf8');
  await query(v1);
  await ensurePrivacy(query);
  const schemaSource = await fs.readFile(path.join(__dirname, '../data-store/schema.js'), 'utf8');
  const sql = schemaSource.match(/CREATE TABLE IF NOT EXISTS workbench_documents \([\s\S]*?\n    \)/)[0];
  await query(sql);
}

test.before(async () => {
  if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status !== 0) return;
  available = true;
  containerName = `linglish-document-privacy-${process.pid}-${Date.now()}`;
  docker('run', '--detach', '--rm', '--name', containerName, '-e', 'POSTGRES_PASSWORD=test', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    if (spawnSync('docker', ['exec', containerName, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { encoding: 'utf8' }).status === 0) { ready = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(ready, true);
  const port = Number(docker('port', containerName, '5432/tcp').trim().split(':').pop());
  process.env.DATABASE_URL = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  core = require('../data-store/core');
  test.mock.method(core, 'init', async () => core.pool);
  ensurePrivacy = require('../data-store/schema').ensureDocumentPrivacySchema;
  await initializeSchema(core.pool.query.bind(core.pool));
  await core.pool.query("INSERT INTO users (id, username, email, password_hash) VALUES (7, 'owner', 'owner@example.test', 'fixture'), (8, 'other', 'other@example.test', 'fixture'), (9, 'admin', 'admin@example.test', 'fixture')");
  store = require('../data-store');
  workbench = require('../services/workbench');
  test.mock.method(require('../services/auth'), 'requireUser', async token => {
    const id = { owner: 7, other: 8, admin: 9 }[token];
    if (!id) throw new Error('UNAUTHORIZED');
    return { id, is_admin: id === 9 };
  });
  const cache = require('../services/cache');
  test.mock.method(cache, 'get', async () => { throw new Error('article routes must not use the shared content cache'); });
  const { registerContentRoutes } = require('../routes/content');
  const { registerStaticRoutes } = require('../routes/static');
  const { registerDocumentRoutes } = require('../routes/documents');
  const { registerWorkbenchRoutes } = require('../routes/workbench');
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      for (const route of [registerDocumentRoutes, registerWorkbenchRoutes, registerContentRoutes, registerStaticRoutes]) {
        if (await route(url.pathname, req, res, url)) return;
      }
      res.writeHead(404); res.end();
    } catch (err) { res.writeHead(500); res.end(err.message); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  await Promise.allSettled(createdFiles.map(p => fs.unlink(p)));
  if (core) await core.pool.end();
  if (containerName) spawnSync('docker', ['rm', '-f', containerName], { encoding: 'utf8' });
});

test('privacy migration works on fresh and existing article schemas, twice, preserving old public rows', async t => {
  if (!available) return t.skip('Docker is unavailable');
  const client = await core.pool.connect();
  try {
    for (const [name, preexistingColumns] of [['fresh_fixture', false], ['legacy_fixture', true]]) {
      await client.query(`CREATE SCHEMA ${name}; SET search_path TO ${name}`);
      const query = client.query.bind(client);
      const v1 = await fs.readFile(path.resolve(__dirname, '../../../docs/db/migrations/V1__initial_schema.sql'), 'utf8');
      await query(v1);
      if (preexistingColumns) await query("ALTER TABLE articles ADD COLUMN pdf_path TEXT, ADD COLUMN visibility TEXT DEFAULT 'public'");
      await query("INSERT INTO articles (title, content, source_type, status) VALUES ('Old public lesson', 'Legacy lesson stays readable.', 'original', 'published')");
      await ensurePrivacy(query); await ensurePrivacy(query);
      const saved = (await query('SELECT * FROM articles')).rows;
      assert.equal(saved.length, 1); assert.equal(saved[0].content, 'Legacy lesson stays readable.');
      assert.equal(saved[0].visibility, 'public'); assert.equal(saved[0].owner_user_id, null);
    }
  } finally {
    await client.query('SET search_path TO public'); client.release();
  }
});

test('two users cannot read each other’s documents, PDFs, images, media or rebuild subtitles', async t => {
  if (!available) return t.skip('Docker is unavailable');
  const { importLearningDocument } = require('../services/document-import');
  const { createClassNote } = require('../services/class-note');
  const pdfBytes = '%PDF-1.4 fixture private lesson';
  const sourcePdf = path.join(__dirname, `fixture-${process.pid}-private.pdf`);
  const sourceImage = path.join(__dirname, `fixture-${process.pid}-card.png`);
  await fs.writeFile(sourcePdf, pdfBytes); await fs.writeFile(sourceImage, Buffer.from([137, 80, 78, 71]));
  createdFiles.push(sourcePdf, sourceImage);
  const owned = await importLearningDocument({ ownerUserId: 7, text: 'This is the owner private lesson.' });
  const other = await importLearningDocument({ ownerUserId: 8, text: 'This is another private lesson.' });
  const pdf = await importLearningDocument({ ownerUserId: 7, file: { path: sourcePdf, originalFilename: `privacy-${process.pid}.pdf`, size: pdfBytes.length } }, { extractText: async () => 'A private PDF sentence for practice.' });
  const note = await createClassNote({ ownerUserId: 7, word: 'milk', image: { path: sourceImage, originalFilename: 'card.png', size: 4 } });
  createdFiles.push(path.join(__dirname, '..', pdf.document.pdfPath), path.join(__dirname, '..', note.note.image));
  const legacy = (await core.pool.query("INSERT INTO articles(title, content, source_type) VALUES ('Public legacy', 'Public lesson.', 'original') RETURNING id")).rows[0];
  const media = (await core.pool.query("INSERT INTO media_assets(article_id, kind, url) VALUES($1,'audio','/private-audio') RETURNING id", [owned.document.id])).rows[0];
  await core.pool.query("INSERT INTO audio_segments(media_id,start_ms,end_ms,text) VALUES($1,0,100,'private segment')", [media.id]);

  const publicList = await request('/articles');
  assert.equal(publicList.status, 200); assert.deepEqual(publicList.json.items.map(a => Number(a.id)), [Number(legacy.id)]);
  const ownerList = await request('/articles', 'owner');
  assert.ok(ownerList.json.items.some(a => Number(a.id) === Number(owned.document.id)));
  assert.equal(ownerList.json.items.some(a => Number(a.id) === Number(other.document.id)), false);
  assert.match(ownerList.headers['cache-control'], /private.*no-store/);
  for (const token of [undefined, 'other']) {
    assert.equal((await request(`/articles/${owned.document.id}`, token)).status, 404);
    assert.equal((await request(`/articles/${pdf.document.id}`, token)).status, 404);
    assert.equal((await request('/media', token)).json.items.length, 0);
    assert.equal((await request('/segments', token)).json.items.length, 0);
    assert.equal((await request(`/media?article_id=${owned.document.id}`, token)).json.items.length, 0);
    assert.equal((await request(`/segments?media_id=${media.id}`, token)).json.items.length, 0);
    assert.ok([401,403,404].includes((await request(pdf.document.pdfPath, token)).status));
    assert.ok([401,403,404].includes((await request(pdf.document.pdfPath, token, { method: 'HEAD' })).status));
    assert.ok([401,403,404].includes((await request(note.note.image, token)).status));
    assert.ok([401,403,404].includes((await request(`/documents/${pdf.document.id}/subtitles`, token, { method: 'POST' })).status));
  }
  for (const bypass of [
    `/static/..%2Fpdfs/${path.basename(pdf.document.pdfPath)}`,
    `/static/%2e%2e/pdfs/${path.basename(pdf.document.pdfPath)}`,
    `/static/..%2Fnote-images/${path.basename(note.note.image)}`,
  ]) assert.ok([401,403,404].includes((await request(bypass)).status));
  const rebuilt = await require('../services/document-import').rebuildReadingSubtitles(
    await store.getArticleById(pdf.document.id, { id: 7 }),
    { user: { id: 7 }, extractText: async () => 'Owner can rebuild this private sentence.' }
  );
  assert.equal(String(rebuilt.document.id), String(pdf.document.id));
  const persisted = (await core.pool.query('SELECT content, visibility, owner_user_id FROM articles WHERE id = $1', [pdf.document.id])).rows[0];
  assert.match(persisted.content, /Owner can rebuild/);
  assert.equal(persisted.visibility, 'private'); assert.equal(persisted.owner_user_id, '7');
  for (const token of ['owner', 'admin']) {
    assert.equal((await request(`/articles/${owned.document.id}`, token)).status, 200);
    assert.equal((await request(pdf.document.pdfPath, token)).text, pdfBytes);
    assert.equal((await request(note.note.image, token)).status, 200);
    assert.equal((await request(note.note.image, token, { method: 'HEAD' })).status, 200);
    assert.equal((await request('/media', token)).json.items.length, 1);
    assert.equal((await request('/segments', token)).json.items.length, 1);
    assert.equal((await request(`/media?article_id=${owned.document.id}`, token)).json.items.length, 1);
    assert.equal((await request(`/segments?media_id=${media.id}`, token)).json.items.length, 1);
  }
});

test('workbench CRUD enforces ownership; publishing is explicit and public access expires or is revoked on deletion', async t => {
  if (!available) return t.skip('Docker is unavailable');
  const created = await request('/api/workbench', 'owner', { method: 'POST', body: { text: 'Please read this lesson aloud.', title: 'Private draft' } });
  assert.equal(created.status, 201); assert.equal(created.json.document.shareToken, null);
  const id = created.json.document.id;
  assert.equal((await request(`/api/workbench/${id}`, 'other')).status, 404);
  assert.equal((await request(`/api/workbench/${id}`, 'other', { method: 'PATCH', body: { title: 'Attack' } })).status, 404);
  assert.equal((await request(`/api/workbench/${id}`, 'other', { method: 'DELETE' })).status, 404);
  assert.equal((await request(`/api/workbench/${id}/practice-link`, 'other', { method: 'POST', body: {} })).status, 404);
  assert.equal((await request('/api/workbench', 'other')).json.items.length, 0);
  assert.equal((await request(`/api/workbench/${id}`, 'owner', { method: 'PATCH', body: { title: 'Updated draft' } })).status, 200);
  const shared = await request(`/api/workbench/${id}/practice-link`, 'owner', { method: 'POST', body: { expiresInDays: 1 } });
  assert.equal(shared.status, 200);
  const articleId = shared.json.document.practiceArticleId;
  const token = shared.json.document.shareToken;
  assert.equal((await store.getArticleById(articleId)).owner_user_id, '7');
  assert.equal((await request(`/articles/${articleId}`)).status, 200);
  assert.equal((await request(`/api/workbench/share/${token}`)).status, 200);
  assert.equal((await request(`/api/workbench/${id}/practice-link`, 'owner', { method: 'POST', body: {} })).status, 200);
  await core.pool.query("UPDATE workbench_documents SET share_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [id]);
  assert.equal((await request(`/api/workbench/share/${token}`)).status, 404);
  assert.equal((await request(`/articles/${articleId}`)).status, 404);
  assert.equal((await request(`/articles/${articleId}`, 'owner')).status, 200);
  await request(`/api/workbench/${id}/practice-link`, 'owner', { method: 'POST', body: {} });
  assert.equal((await request(`/articles/${articleId}`)).status, 200);
  assert.equal((await request(`/api/workbench/${id}`, 'owner', { method: 'DELETE' })).status, 200);
  assert.equal((await request(`/articles/${articleId}`)).status, 404);
});

test('static aliases cannot bypass protected video and recording routes', async t => {
  if (!available) return t.skip('Docker is unavailable');
  const videoPath = `/videos/privacy-alias-${process.pid}.mp4`;
  const recordingPath = `/recordings/video-55/user-7/privacy-alias-${process.pid}.mp3`;
  for (const relative of [videoPath, recordingPath]) {
    const file = path.join(__dirname, '../public', relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'private media bytes'); createdFiles.push(file);
    const aliases = [
      `/static${relative}`,
      `/static/audio/../${relative.slice(1)}`,
      `/static/%${relative.charCodeAt(1).toString(16)}${relative.slice(2)}`,
      `/static${relative.replaceAll('/', '%2F')}`,
    ];
    for (const token of [undefined, 'other']) {
      for (const method of ['GET', 'HEAD']) {
        for (const alias of aliases) {
          assert.ok([401,403,404].includes((await request(alias, token, { method })).status), `${method} ${alias} must remain protected`);
        }
      }
    }
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { handleFileUpload, UPLOAD_DIR } = require('../upload-handler');

function multipartBody(fields, file) {
  const boundary = '----LinglishBoundary7MA4YWxkTrZu0gW';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
    );
  }
  chunks.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
    `Content-Type: ${file.type}\r\n\r\n`
  );
  const head = Buffer.from(chunks.join(''));
  const mid = Buffer.from(file.bytes);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    boundary,
    body: Buffer.concat([head, mid, tail]),
  };
}

test('multipart file uploads finish writing before handleFileUpload resolves', async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(2400, 7), 0xff, 0xd9]);
  const { boundary, body } = multipartBody({ word: 'boom' }, {
    name: 'card.jpg',
    type: 'image/jpeg',
    bytes,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const { files } = await handleFileUpload(req, { maxTotalBytes: 12 * 1024 * 1024 });
      const file = files.file;
      assert.ok(file?.path);
      const stat = await fsp.stat(file.path);
      assert.equal(stat.size, bytes.length);
      assert.equal(file.size, bytes.length);
      const saved = await fsp.readFile(file.path);
      assert.equal(saved.length, bytes.length);
      await fsp.unlink(file.path).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, size: stat.size }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.size, bytes.length);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.ok(fs.existsSync(UPLOAD_DIR));
});

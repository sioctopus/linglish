const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the exam reader loads the selected private article with the renewed account credential', async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/exam-paper.html'), 'utf8');
  const source = html.slice(html.indexOf('    async function loadPaper() {'), html.indexOf('\n    loadPaper();'));
  let renewed = false;
  let rendered = false;
  const article = { id: 12, content: JSON.stringify({ kind: 'exam-paper', blocks: [] }) };
  const sandbox = {
    URLSearchParams,
    location: { search: '?id=12' },
    document: { getElementById() { return { innerHTML: '' }; } },
    window: { AuthManager: { async ensureSession() { renewed = true; } } },
    readToken: () => renewed ? 'renewed-credential' : '',
    escapeHtml: value => value,
    tagNames: () => ['exam'],
    renderPaper: value => { assert.equal(value.id, 12); rendered = true; },
    fetch: async (url, options) => {
      assert.equal(url, '/articles/12');
      assert.equal(options.headers.Authorization, 'Bearer renewed-credential');
      assert.equal(options.cache, 'no-store');
      return { ok: true, json: async () => article };
    },
  };
  vm.runInNewContext(source, sandbox);
  await sandbox.loadPaper();
  assert.equal(rendered, true);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/workbench/import-bridge.js'), 'utf8');
function harness(blocked = false) {
  const values = new Map();
  const navigations = [];
  const alerts = [];
  const sandbox = {
    URLSearchParams,
    sessionStorage: { setItem(k, v) { if (blocked) throw new Error('blocked'); values.set(k, v); }, getItem: k => values.get(k) || null, removeItem: k => values.delete(k) },
    location: { assign(url) { navigations.push({ sameTab: true, url }); } },
    open(url, target, features) { navigations.push({ sameTab: false, url, target, features }); },
    alert(message) { alerts.push(message); },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  return { api: sandbox.WorkbenchImport, navigations, alerts };
}

test('intensive-note import navigates in the same tab so its session payload survives noopener isolation', () => {
  const h = harness();
  assert.equal(h.api.openIntensiveNote({ text: 'A sentence to study.', title: 'Lesson 1' }), true);
  assert.equal(h.navigations.length, 1);
  assert.equal(h.navigations[0].sameTab, true, 'noopener tabs cannot inherit the source sessionStorage');
  assert.match(h.navigations[0].url, /workbench\.html\?import=1/);
  assert.equal(h.api.consume().text, 'A sentence to study.');
  assert.equal(h.api.consume(), null, 'import payload is consumed once');
});

test('failed payload storage keeps the selected text on the current page and reports the failure', () => {
  const h = harness(true);
  assert.equal(h.api.openIntensiveNote({ text: 'Keep this selected sentence.' }), false);
  assert.deepEqual(h.navigations, []);
  assert.equal(h.alerts.length, 1);
});

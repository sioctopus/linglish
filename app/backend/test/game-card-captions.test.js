const test = require('node:test');
const assert = require('node:assert/strict');
const views = require('../../frontend/js/game/game-views');

// Only the DOM operations used by the deck renderer; audio stays at its API boundary.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this.classList = { add: (name) => { this.className += ' ' + name; } };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((node) => node.textContent).join(''); }
  appendChild(node) {
    if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
    this.children.push(node);
    node.parentNode = this;
    return node;
  }
  insertBefore(node, before) {
    this.children.splice(this.children.indexOf(before), 0, node);
    node.parentNode = this;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  click() { this.listeners.click?.({ target: this }); }
  querySelector(selector) {
    for (const node of this.children) {
      if (node.className.split(/\s+/).includes(selector.slice(1))) return node;
      const nested = node.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function deckFixture(t) {
  const previous = global.document;
  global.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => { const node = new Element('span'); node.textContent = text; return node; }, addEventListener() {}, removeEventListener() {} };
  const container = new Element('main');
  const spoken = [];
  let leave;
  views.renderCardDeck({
    container,
    api: { speak: (word) => { spoken.push(word); }, setSpeakIdle() {} },
    bindLeave: (callback) => { leave = callback; },
  }, { id: 'animals', label: '动物', words: [
    { lemma: 'elephant', zh: '大象', ipa: '/ˈelɪfənt/', emoji: '🐘', photo: '/elephant.jpg' },
    { lemma: 'hippopotamus', zh: '河马', ipa: '/ˌhɪpəˈpɒtəməs/', emoji: '🦛', photo: '/hippo.jpg' },
  ] });
  t.after(() => { leave(); global.document = previous; });
  return { container, spoken };
}

test('deck captions can be hidden and shown without restarting pronunciation', (t) => {
  const { container, spoken } = deckFixture(t);
  const toggle = container.querySelector('.game-caption-toggle');
  assert.ok(toggle, 'a caption switch is available beside the deck title');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(container.querySelector('.game-word-copy').hidden, false);
  toggle.click();
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(container.querySelector('.game-word-copy').hidden, true);
  toggle.click();
  assert.equal(container.querySelector('.game-word-copy').hidden, false);
  assert.deepEqual(spoken, ['elephant']);
});

test('flipping a card preserves the hidden-caption choice and still pronounces the next word', (t) => {
  const { container, spoken } = deckFixture(t);
  const toggle = container.querySelector('.game-caption-toggle');
  assert.ok(toggle, 'a caption switch is available');
  toggle.click();
  const next = container.querySelector('.game-card-nav').children[2];
  next.click();
  assert.equal(container.querySelector('.game-word-copy').hidden, true);
  assert.deepEqual(spoken, ['elephant', 'hippopotamus']);
  toggle.click();
  assert.match(container.querySelector('.game-word-copy').textContent, /hippopotamus/);
  assert.equal(container.querySelector('.game-word-copy').hidden, false);
});

test('Space on a native button is reserved for its own action, while body Space plays audio', () => {
  assert.equal(views.cardKeyAction({ key: ' ', code: 'Space', target: { tagName: 'BUTTON' } }), null);
  assert.equal(views.cardKeyAction({ key: ' ', code: 'Space', target: { tagName: 'BODY' } }), 'toggle');
});

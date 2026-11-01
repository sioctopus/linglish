const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const photos = path.resolve(__dirname, '../../frontend/images/game/photos');
const pack = require('../../frontend/js/game/word-packs/card-decks.json');
const manifestPath = path.join(photos, 'THEME_PHOTO_SOURCES.json');

function manifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('new theme photographs have verified source, license, author and matching bytes', () => {
  const data = manifest();
  assert.equal(data.version, 1);
  assert.ok(data.images.length > 90);
  const names = new Set();
  for (const source of data.images) {
    assert.ok(!names.has(source.file), source.file);
    names.add(source.file);
    assert.match(source.file, /^[a-z-]+\.jpg$/);
    assert.match(source.sourceUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    assert.ok(source.author, source.file);
    assert.match(source.license, /^(?:CC BY(?:-SA)? (?:2\.0|2\.5|3\.0|4\.0)|CC0|Public domain)$/);
    assert.match(source.licenseUrl, /^https?:\/\//);
    assert.match(source.changes, /640/);
    assert.equal(source.sha256, createHash('sha256').update(fs.readFileSync(path.join(photos, source.file))).digest('hex'), source.file);
  }
});

test('cards without verified photographs retain their existing emoji fallback', () => {
  const data = manifest();
  for (const fallback of data.emojiFallbacks) {
    const deck = pack.decks.find(item => item.id === fallback.deck);
    const word = deck.words.find(item => item.lemma === fallback.lemma);
    assert.ok(word, fallback.lemma);
    assert.ok(word.emoji, fallback.lemma);
    assert.ok(!word.photo, fallback.lemma);
    assert.equal(fs.existsSync(path.join(photos, fallback.removedFile)), false, fallback.removedFile);
  }
});

test('theme photo refresh rejects unknown rights, missing creators, and changed source selection', () => {
  const { verifiedCredit } = require('../scripts/fetch-theme-photos-ps');
  const source = { title: 'File:Sample.jpg' };
  const metadata = {
    Artist: { value: '<a href="/wiki/User:Example">Example &amp; Co.</a>' },
    LicenseShortName: { value: 'CC BY-SA 4.0' },
    LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  };
  const page = { title: source.title, imageinfo: [{ mime: 'image/jpeg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Sample.jpg', url: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Sample.jpg', extmetadata: metadata }] };
  assert.equal(verifiedCredit(source, page).author, 'Example & Co.');
  assert.throws(() => verifiedCredit(source, { ...page, title: 'File:Other.jpg' }), /source/i);
  assert.throws(() => verifiedCredit(source, { ...page, imageinfo: [{ ...page.imageinfo[0], extmetadata: { ...metadata, Artist: { value: '' } } }] }), /author/i);
  for (const license of ['No restrictions', 'CC BY-NC 4.0', 'CC BY-ND 4.0', 'Unknown']) {
    assert.throws(() => verifiedCredit(source, { ...page, imageinfo: [{ ...page.imageinfo[0], extmetadata: { ...metadata, LicenseShortName: { value: license } } }] }), /license/i);
  }
});

test('each added theme card image is credited and replaced images invalidate the cache', () => {
  const data = manifest();
  const credited = new Map(data.images.map(source => [source.file, source]));
  const legacy = new Set(['cup.jpg', 'towel.jpg', 'student.jpg']);
  const attribution = fs.readFileSync(path.join(photos, 'ATTRIBUTION.md'), 'utf8');
  const { creditsMarkdown } = require('../scripts/fetch-theme-photos-ps');
  assert.ok(attribution.includes(creditsMarkdown(data)));
  assert.equal(data.images.length + data.emojiFallbacks.length, 129);
  for (const deck of pack.decks.filter(item => ['home', 'jobs', 'family'].includes(item.id))) {
    for (const word of deck.words.filter(item => item.photo)) {
      const file = word.photo.match(/\/([^/?]+)\?/)?.[1];
      if (legacy.has(file)) continue;
      assert.ok(credited.has(file), word.lemma);
      assert.match(word.photo, /\?v=2026103101$/, word.lemma);
    }
  }
});

test('deck regeneration preserves the integrated decks and intentional fallbacks', () => {
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linglish-theme-decks-'));
  try {
    const file = path.join(directory, 'decks.json');
    const original = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/game/word-packs/card-decks.json'), 'utf8');
    fs.writeFileSync(file, original);
    const { main } = require('../scripts/patch-home-jobs-family-decks');
    main(file);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    main(file);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

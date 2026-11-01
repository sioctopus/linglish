#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pack = require('../../frontend/js/game/word-packs/card-decks.json');
const manifest = require('../../frontend/images/game/photos/THEME_PHOTO_SOURCES.json');
const root = path.resolve(__dirname, '../../frontend');
let failures = 0;
for (const id of ['home', 'jobs', 'family']) {
  const deck = pack.decks.find(item => item.id === id);
  if (!deck) { console.error('Missing deck: ' + id); failures += 1; continue; }
  console.log(id + ': ' + deck.words.length + ' cards');
  for (const word of deck.words) {
    if (!word.photo) {
      if (word.emoji && manifest.emojiFallbacks.some(item => item.deck === id && item.lemma === word.lemma)) continue;
      console.error('Unverified fallback: ' + word.lemma);
      failures += 1;
      continue;
    }
    const file = path.join(root, word.photo.replace(/^\//, '').replace(/\?.*/, ''));
    if (!fs.existsSync(file) || fs.statSync(file).size < 5000) {
      console.error('Missing image: ' + word.lemma);
      failures += 1;
    }
  }
}
process.exitCode = failures ? 1 : 0;

#!/usr/bin/env node
'use strict';

/**
 * Legacy entry point: fallback cards now render their emoji in the application.
 * Do not export a platform's proprietary color-emoji font into bundled JPEGs.
 * Usage: node scripts/generate-theme-emoji-photos.js
 */
const fs = require('node:fs');
const path = require('node:path');

function main() {
  const manifest = require('../../frontend/images/game/photos/THEME_PHOTO_SOURCES.json');
  const pack = require('../../frontend/js/game/word-packs/card-decks.json');
  const photos = path.resolve(__dirname, '../../frontend/images/game/photos');
  for (const fallback of manifest.emojiFallbacks) {
    const word = pack.decks.find(deck => deck.id === fallback.deck)?.words.find(item => item.lemma === fallback.lemma);
    if (!word?.emoji || word.photo) throw new Error('Expected native emoji fallback: ' + fallback.lemma);
    if (fs.existsSync(path.join(photos, fallback.removedFile))) throw new Error('Remove unverified bundled fallback image: ' + fallback.removedFile);
    console.log('native emoji: ' + fallback.lemma);
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };

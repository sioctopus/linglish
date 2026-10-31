'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pack = require('../../frontend/js/game/word-packs/card-decks.json');
const root = path.resolve(__dirname, '../../frontend');
['home', 'jobs', 'family'].forEach((id) => {
  const deck = pack.decks.find((item) => item.id === id);
  console.log(id, deck.words.length);
  deck.words.forEach((word) => {
    const file = path.join(root, word.photo.replace(/^\//, '').replace(/\?.*/, ''));
    if (!fs.existsSync(file) || fs.statSync(file).size < 5000) {
      console.log(' BAD', word.lemma, fs.existsSync(file) ? fs.statSync(file).size : 'missing');
    }
  });
});

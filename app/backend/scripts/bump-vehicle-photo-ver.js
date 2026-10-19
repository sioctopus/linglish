#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '../../frontend/js/game/word-packs/card-decks.json');
const slugs = new Set([
  'ambulance', 'police-car', 'fire-truck', 'scooter', 'tram', 'tractor', 'jeep',
  'convertible', 'rocket', 'yacht', 'canoe', 'ferry', 'hot-air-balloon',
  'skateboard', 'roller-skates', 'carriage', 'cable-car', 'taxi',
  'helicopter', 'van',
]);
const ver = process.argv[2] || 'v=8';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
let n = 0;
for (const deck of data.decks || []) {
  for (const word of deck.words || []) {
    if (!word.photo) continue;
    const base = String(word.photo).split('?')[0];
    const slug = path.basename(base, path.extname(base));
    if (slugs.has(slug)) {
      word.photo = base + '?' + ver;
      n += 1;
    }
  }
}
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
console.log('bumped', n, 'to', ver);

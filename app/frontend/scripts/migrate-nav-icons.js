/**
 * One-shot helper: replace bottom-nav emoji with data-lx-icon + link icons assets.
 * Run: node app/frontend/scripts/migrate-nav-icons.js
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..');
const files = fs.readdirSync(dir).filter((f) => /^mobile-.*\.html$/.test(f) || [
  'practice-session.html',
  'video-reader.html',
  'practice-session-refactored.html',
].includes(f));

const replacements = [
  [/<span class="nav-icon">\s*🎯\s*<\/span>/g, '<span class="nav-icon" data-lx-icon="today"></span>'],
  [/<span class="nav-icon">\s*🌍\s*<\/span>/g, '<span class="nav-icon" data-lx-icon="explore"></span>'],
  [/<span class="nav-icon">\s*⚡\s*<\/span>/g, '<span class="nav-icon" data-lx-icon="power"></span>'],
  [/<span class="nav-icon">\s*🎪\s*<\/span>/g, '<span class="nav-icon" data-lx-icon="arena"></span>'],
  [/<span class="nav-icon">\s*🪴\s*<\/span>/g, '<span class="nav-icon" data-lx-icon="growth"></span>'],
  [/<div class="nav-icon">\s*<span class="nav-emoji">🎯<\/span>\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="today"></div>'],
  [/<div class="nav-icon">\s*<span class="nav-emoji">🌍<\/span>\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="explore"></div>'],
  [/<div class="nav-icon">\s*<span class="nav-emoji">⚡<\/span>\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="power"></div>'],
  [/<div class="nav-icon">\s*<span class="nav-emoji">🎪<\/span>\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="arena"></div>'],
  [/<div class="nav-icon">\s*<span class="nav-emoji">🪴<\/span>\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="growth"></div>'],
  [/<div class="nav-icon">\s*<span class="nav-emoji">💬<\/span>\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="message"></div>'],
  [/<div class="nav-icon">\s*🌍\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="explore"></div>'],
  [/<div class="nav-icon">\s*⚡\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="power"></div>'],
  [/<div class="nav-icon">\s*🎪\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="arena"></div>'],
  [/<div class="nav-icon">\s*🪴\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="growth"></div>'],
  [/<div class="nav-icon">\s*💬\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="message"></div>'],
  [/<div class="nav-icon">\s*🎯\s*<\/div>/g, '<div class="nav-icon" data-lx-icon="today"></div>'],
];

const changed = [];
for (const f of files) {
  const p = path.join(dir, f);
  let s = fs.readFileSync(p, 'utf8');
  if (!s.includes('bottom-nav')) continue;
  const before = s;
  for (const [re, to] of replacements) s = s.replace(re, to);
  if (s === before) continue;

  if (!s.includes('styles/icons.css')) {
    if (s.includes('tokens.css')) {
      s = s.replace(
        /(<link rel="stylesheet" href="\.\/styles\/tokens\.css[^"]*">)/,
        '$1\n  <link rel="stylesheet" href="./styles/icons.css?v=1">'
      );
    } else if (s.includes('</head>')) {
      s = s.replace('</head>', '  <link rel="stylesheet" href="./styles/icons.css?v=1">\n</head>');
    }
  }
  if (!s.includes('js/icons.js')) {
    s = s.replace('</body>', '  <script src="./js/icons.js?v=1"></script>\n</body>');
  }
  fs.writeFileSync(p, s);
  changed.push(f);
}

console.log('changed', changed.length);
console.log(changed.join('\n'));

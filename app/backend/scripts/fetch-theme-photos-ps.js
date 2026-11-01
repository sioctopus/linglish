#!/usr/bin/env node
'use strict';

/**
 * Refresh the explicitly reviewed Commons sources for home/jobs/family cards.
 * The historical filename is retained for existing commands; PowerShell is no
 * longer required. Search results are never selected automatically: update the
 * source manifest only after reviewing the image and its redistribution terms.
 * Usage: node scripts/fetch-theme-photos-ps.js home|jobs|family|all [--force]
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

const OUT = path.resolve(__dirname, '../../frontend/images/game/photos');
const MANIFEST = path.join(OUT, 'THEME_PHOTO_SOURCES.json');
const ATTRIBUTION = path.join(OUT, 'ATTRIBUTION.md');
const USER_AGENT = 'LinglishOSS/1.0 (educational vocabulary cards; https://linglish.org)';
const START = '<!-- THEME_PHOTO_CREDITS_START -->';
const END = '<!-- THEME_PHOTO_CREDITS_END -->';
const CHANGES = 'Resized to fit 640 × 640, padded with an off-white background and re-encoded as JPEG; no crop.';
const FREE_LICENSE = /^(?:CC BY(?:-SA)? (?:2\.0|2\.5|3\.0|4\.0)|CC0|Public domain)$/;

function plainText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, value) => {
      const point = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : parseInt(value, 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function verifiedCredit(source, page) {
  if (!page || page.title !== source.title) throw new Error('Selected source changed or is missing: ' + source.title);
  const info = page.imageinfo && page.imageinfo[0];
  if (!info || !/^image\/(?:jpeg|png|webp|tiff)$/.test(info.mime || '')) throw new Error('Unsupported source image: ' + source.title);
  const metadata = info.extmetadata || {};
  const license = plainText(metadata.LicenseShortName?.value);
  if (!FREE_LICENSE.test(license)) throw new Error('Unverified or incompatible license: ' + license);
  let author = plainText(metadata.Artist?.value);
  if (!author) {
    // Public-domain works can genuinely have an unknown creator; never invent one.
    if (license === 'Public domain' && metadata.Copyrighted?.value?.toLowerCase() === 'false') author = 'Unknown author (not supplied by Commons)';
    else throw new Error('Missing source author: ' + source.title);
  }
  const sourceUrl = info.descriptionurl;
  if (!/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/.test(sourceUrl || '')) throw new Error('Unverified Commons source URL');
  const licenseUrl = metadata.LicenseUrl?.value || (license === 'Public domain' ? sourceUrl + '#Licensing' : '');
  if (!/^https?:\/\//.test(licenseUrl)) throw new Error('Missing license URL: ' + source.title);
  if (license !== 'Public domain') {
    const licensePath = license === 'CC0' ? '/publicdomain/zero/1.0' : '/licenses/' + license.slice(3).toLowerCase().replace(' ', '/') ;
    const url = new URL(licenseUrl);
    if (url.hostname !== 'creativecommons.org' || !(url.pathname === licensePath || url.pathname.startsWith(licensePath + '/'))) throw new Error('License URL does not match the declared license');
  }
  if (license === 'Public domain' && metadata.Copyrighted?.value?.toLowerCase() !== 'false') throw new Error('Unverified public-domain declaration');
  if (/\bai\b/i.test(plainText(metadata.Restrictions?.value))) throw new Error('Generated image requires separate review');
  return { author, attribution: plainText(metadata.Attribution?.value), license, licenseUrl, sourceUrl, title: page.title, restrictions: plainText(metadata.Restrictions?.value) };
}

async function request(url, accept) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60000),
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' retrieving ' + url);
  return response;
}

async function commonsPage(title) {
  const response = await request('https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', titles: title,
    prop: 'imageinfo', iiprop: 'url|mime|extmetadata|sha1', iiurlwidth: '960',
  }), 'application/json');
  const result = await response.json();
  return Object.values(result.query?.pages || {}).find(page => page.title === title);
}

async function squareJpeg(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(640, 640);
  const context = canvas.getContext('2d');
  context.fillStyle = '#f8fafc';
  context.fillRect(0, 0, 640, 640);
  const scale = Math.min(640 / image.width, 640 / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  context.drawImage(image, (640 - width) / 2, (640 - height) / 2, width, height);
  return canvas.toBuffer('image/jpeg', 90);
}

function markdown(value) {
  return String(value).replace(/\|/g, '&#124;').replace(/\n/g, ' ');
}

function creditsMarkdown(manifest) {
  const rows = manifest.images.map(source => '| `' + source.file + '` | ' + markdown(source.author + (source.attribution ? '; requested credit: ' + source.attribution : '')) + ' | [' + markdown(source.title.replace(/^File:/, '')) + '](' + source.sourceUrl.replace(/\(/g, '%28').replace(/\)/g, '%29') + ') | [' + source.license + '](' + source.licenseUrl + ') | ' + markdown(source.changes) + ' |');
  const fallbacks = manifest.emojiFallbacks.map(item => '`' + item.lemma + '`').join(', ');
  return START + '\n## Home, occupation and family card image credits\n\n' +
    'These photographs, historical pictures and illustrations were reviewed against the bundled images. License and author metadata were verified through the official Wikimedia Commons API. Each file retains its source license; CC BY-SA adaptations are distributed under the corresponding share-alike license. Public-domain links point to the source declaration when Commons supplies no separate license URL. Complete records, verification dates and SHA-256 hashes are in [THEME_PHOTO_SOURCES.json](THEME_PHOTO_SOURCES.json).\n\n' +
    '| Local file | Author | Original Commons file | License / declaration | Changes |\n| --- | --- | --- | --- | --- |\n' + rows.join('\n') + '\n\n' +
    'Cards using the application’s existing emoji fallback, with no bundled image: ' + fallbacks + '. The previous unrelated search-result images and proprietary-font emoji JPEGs for these cards were removed.\n\n' +
    'Some source pages note personality rights; these are recorded in the manifest. A copyright license does not imply endorsement by a depicted person.\n' + END;
}

function saveAttribution(manifest) {
  const current = fs.readFileSync(ATTRIBUTION, 'utf8');
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  const block = creditsMarkdown(manifest);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error('Malformed attribution markers');
  const updated = start < 0 ? current.trimEnd() + '\n\n' + block + '\n' : current.slice(0, start) + block + current.slice(end + END.length);
  fs.writeFileSync(ATTRIBUTION, updated);
}

async function main(args = process.argv.slice(2)) {
  const kind = args[0];
  if (!['home', 'jobs', 'family', 'all'].includes(kind)) throw new Error('Usage: node scripts/fetch-theme-photos-ps.js home|jobs|family|all [--force]');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  for (const source of manifest.images.filter(item => kind === 'all' || item.decks.includes(kind))) {
    const destination = path.join(OUT, source.file);
    if (fs.existsSync(destination) && !args.includes('--force')) {
      const hash = createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
      if (hash !== source.sha256) throw new Error('Local image differs from reviewed source: ' + source.file);
      console.log('keep ' + source.file);
      continue;
    }
    const page = await commonsPage(source.title);
    const credit = verifiedCredit(source, page);
    if (credit.license !== source.license) throw new Error('Source license changed; review before refreshing: ' + source.file);
    const info = page.imageinfo[0];
    const response = await request(info.thumburl || info.url, 'image/*');
    if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error('Expected image content');
    const jpeg = await squareJpeg(Buffer.from(await response.arrayBuffer()));
    fs.writeFileSync(destination, jpeg);
    Object.assign(source, credit, { changes: CHANGES, verifiedAt: new Date().toISOString().slice(0, 10), sourceOriginalUrl: info.url.split('?')[0], sourceSha1: info.sha1, sha256: createHash('sha256').update(jpeg).digest('hex') });
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    saveAttribution(manifest);
    console.log('refreshed ' + source.file);
    // Wikimedia rate limits apply even when every source is explicitly selected.
    await new Promise(resolve => setTimeout(resolve, 5500));
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, verifiedCredit, creditsMarkdown, saveAttribution, squareJpeg, CHANGES };

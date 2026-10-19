const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const frontend = path.resolve(__dirname, '../../frontend');
const svgPath = path.join(frontend, 'linglish-favicon.svg');

function roundedRect(ctx, x, y, size, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + size, y, x + size, y + size, radius);
  ctx.arcTo(x + size, y + size, x, y + size, radius);
  ctx.arcTo(x, y + size, x, y, radius);
  ctx.arcTo(x, y, x + size, y, radius);
  ctx.closePath();
}

async function drawIcon(img, size, options) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const pad = Math.round(size * (options.padding || 0));
  const radius = Math.round(size * (options.radius || 0.22));

  if (options.background) {
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#0f766e');
    gradient.addColorStop(1, '#2dd4bf');
    ctx.fillStyle = gradient;
    if (options.maskable) {
      ctx.fillRect(0, 0, size, size);
    } else {
      roundedRect(ctx, 0, 0, size, radius);
      ctx.fill();
    }
  }

  const box = size - pad * 2;
  ctx.drawImage(img, pad, pad, box, box);
  return canvas.toBuffer('image/png');
}

async function main() {
  const img = await loadImage(svgPath);
  const files = [
    ['icon-192x192.png', 192, { background: true, padding: 0.16, radius: 0.22 }],
    ['icon-512x512.png', 512, { background: true, padding: 0.16, radius: 0.22 }],
    ['apple-touch-icon.png', 180, { background: true, padding: 0.16, radius: 0.22 }],
    ['icon-maskable-512.png', 512, { background: true, maskable: true, padding: 0.28, radius: 0 }],
  ];

  for (const [name, size, options] of files) {
    const png = await drawIcon(img, size, options);
    fs.writeFileSync(path.join(frontend, name), png);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

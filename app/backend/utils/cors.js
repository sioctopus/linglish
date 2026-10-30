const ALLOWED_ORIGINS = [
  'https://example.com',
  'https://www.example.com',
  'http://localhost:4000',
  'http://127.0.0.1:4000',
];

if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://127.0.0.1:3000');
}

if (process.env.CORS_ALLOWED_ORIGINS) {
  process.env.CORS_ALLOWED_ORIGINS
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
    .forEach(origin => ALLOWED_ORIGINS.push(origin));
}

function isDevTunnelOrigin(origin) {
  // Quick tunnels for phone testing without same-LAN Wi‑Fi (Chrome often fails CF challenges).
  return /^https:\/\/[a-z0-9-]+\.(trycloudflare\.com|loca\.lt|lhr\.life|pinggy\.io)$/i.test(String(origin || ''));
}

function isChromeExtensionOrigin(origin) {
  // Unpacked / store extension origins for Linglish Chrome helper (popup fetch / bridge).
  // Prefer listing exact chrome-extension://<id> via CORS_ALLOWED_ORIGINS in production.
  return /^chrome-extension:\/\/[a-z]{32}$/i.test(String(origin || ''));
}

function getCorsHeaders(origin, options = {}) {
  const { logUnknown = true } = options;
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, If-Range, X-Linglish-Device',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag, Last-Modified',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  if (
    origin &&
    (ALLOWED_ORIGINS.includes(origin) || isDevTunnelOrigin(origin) || isChromeExtensionOrigin(origin))
  ) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else if (!origin || origin === 'null') {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGINS[0];
  } else if (logUnknown) {
    console.warn('Request from unknown origin:', origin);
  }

  return headers;
}

function appendVary(current, value) {
  const fields = String(current || '')
    .split(',')
    .map(field => field.trim())
    .filter(Boolean);
  for (const candidate of String(value || '').split(',').map(field => field.trim()).filter(Boolean)) {
    if (!fields.some(field => field.toLowerCase() === candidate.toLowerCase())) fields.push(candidate);
  }
  return fields.join(', ');
}

module.exports = {
  ALLOWED_ORIGINS,
  getCorsHeaders,
  appendVary,
  isChromeExtensionOrigin,
};

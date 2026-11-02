const dataStore = require('../data-store');
const { authenticate, authenticateBearer } = require('../middleware/auth');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { isPrivateHostname } = require('../services/media-library');

const APPLICATION_FIELDS = ['id', 'user_id', 'display_name', 'bio', 'topic', 'sample_url', 'rights_confirmed', 'status', 'revision', 'reviewed_by', 'review_note', 'reviewed_at', 'submitted_at', 'created_at', 'updated_at'];
const SUBMISSION_FIELDS = new Set(['display_name', 'bio', 'topic', 'sample_url', 'rights_confirmed']);
const REVIEW_FIELDS = new Set(['decision', 'review_note', 'expected_revision']);

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function publicApplication(application) {
  if (!application) return null;
  return Object.fromEntries(APPLICATION_FIELDS.filter(key => application[key] !== undefined).map(key => [key, application[key]]));
}

async function requireMember(req, admin = false) {
  // Explicit bearer credentials keep browser-supplied cookies from authorizing
  // cross-origin form submissions. Reads retain the normal account fallback.
  const user = req.method === 'POST' ? await authenticateBearer(req) : await authenticate(req);
  if (!user?.id) fail('UNAUTHORIZED', 401);
  if (/^guest_.*@temp\.linglish\.local$/i.test(String(user.email || ''))) fail('CREATOR_REGISTERED_ACCOUNT_REQUIRED', 403);
  if (admin && user.is_admin !== true) fail('FORBIDDEN', 403);
  return user;
}

async function readBody(req, allowedFields) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16 * 1024) fail('CREATOR_BODY_TOO_LARGE', 413);
    chunks.push(buffer);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { fail('INVALID_JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_CREATOR_BODY');
  if (Object.keys(body).some(key => !allowedFields.has(key))) fail('INVALID_CREATOR_FIELDS');
  return body;
}

function text(value, max, name, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string') fail(`INVALID_CREATOR_${name}`);
  const normalized = value.trim();
  if ((!optional && !normalized) || normalized.length > max) fail(`INVALID_CREATOR_${name}`);
  return normalized || null;
}

function sampleUrl(value) {
  const raw = text(value, 2000, 'SAMPLE_URL', true);
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch (_) { fail('INVALID_CREATOR_SAMPLE_URL'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.href.length > 2000 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || isPrivateHostname(host) || (!host.includes('.') && !host.includes(':'))
      || /\.(test|invalid|example|lan|home)$/i.test(host)) fail('INVALID_CREATOR_SAMPLE_URL');
  // Store the link as text only. Submitting/reviewing never fetches this URL.
  return url.href;
}

function handleFailure(res, error) {
  const status = error.status || mapErrorToStatus(error, 500);
  const message = status >= 500 && status !== 503 ? 'CREATOR_APPLICATION_FAILED' : error.message;
  return sendError(res, status, message);
}

async function registerCreatorRoutes(pathname, req, res, url) {
  if (pathname === '/api/creator/application' && ['GET', 'POST'].includes(req.method)) {
    try {
      const user = await requireMember(req);
      res.setHeader('Cache-Control', 'private, no-store');
      if (req.method === 'GET') {
        return sendJson(res, 200, { application: publicApplication(await dataStore.getCreatorApplication(user.id)) });
      }
      const body = await readBody(req, SUBMISSION_FIELDS);
      const payload = {
        display_name: text(body.display_name, 80, 'DISPLAY_NAME'),
        bio: text(body.bio, 1200, 'BIO'),
        topic: text(body.topic, 80, 'TOPIC'),
        sample_url: sampleUrl(body.sample_url),
        rights_confirmed: body.rights_confirmed,
      };
      if (payload.rights_confirmed !== true) fail('CREATOR_RIGHTS_CONFIRMATION_REQUIRED');
      const result = await dataStore.submitCreatorApplication(user.id, payload);
      return sendJson(res, result.created ? 201 : 200, { application: publicApplication(result.application) });
    } catch (error) { return handleFailure(res, error); }
  }

  if (pathname === '/admin/creator-applications' && req.method === 'GET') {
    try {
      await requireMember(req, true);
      res.setHeader('Cache-Control', 'private, no-store');
      const result = await dataStore.listCreatorApplications({
        status: url.searchParams.get('status') || 'pending',
        limit: url.searchParams.get('limit') ?? 50,
        offset: url.searchParams.get('offset') ?? 0,
      });
      return sendJson(res, 200, { ...result, items: result.items.map(publicApplication) });
    } catch (error) { return handleFailure(res, error); }
  }

  const review = pathname.match(/^\/admin\/creator-applications\/([1-9]\d{0,18})\/review$/);
  if (review && req.method === 'POST') {
    try {
      const user = await requireMember(req, true);
      res.setHeader('Cache-Control', 'private, no-store');
      const body = await readBody(req, REVIEW_FIELDS);
      if (body.decision !== 'approved' && body.decision !== 'rejected') fail('INVALID_CREATOR_DECISION');
      if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1) fail('INVALID_CREATOR_REVISION');
      const application = await dataStore.reviewCreatorApplication(review[1], {
        decision: body.decision,
        expected_revision: body.expected_revision,
        review_note: text(body.review_note, 1200, 'REVIEW_NOTE', true),
        reviewer_id: user.id,
      });
      return sendJson(res, 200, { application: publicApplication(application) });
    } catch (error) { return handleFailure(res, error); }
  }
  return false;
}

module.exports = { registerCreatorRoutes };

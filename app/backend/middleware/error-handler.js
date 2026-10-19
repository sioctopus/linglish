/**
 * Error handling middleware
 * Maps error types to HTTP status codes
 */

function mapErrorToStatus(err, defaultStatus = 500) {
  if (!err || !err.message) return defaultStatus;
  if (
    err.message === 'UNAUTHORIZED'
    || err.message === 'TOKEN_EXPIRED'
    || err.message === 'INVALID_TOKEN'
    || err.message === 'GOOGLE_AUTHORIZATION_REVOKED'
    || err.message === 'SESSION_EXPIRED'
  ) {
    return 401;
  }
  if (err.message === 'FORBIDDEN' || err.message === 'BANNED' || err.status === 403) {
    return 403;
  }
  if (err.message === 'DATASTORE_UNAVAILABLE') {
    return 503;
  }
  if (err.message === 'AUTH_TOKEN_SECRET_REQUIRED') {
    return 503;
  }
  return defaultStatus;
}

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) {
    console.warn('Attempted to send response after stream closed');
    return true;
  }
  const JSON_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Linglish-Device',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS',
  };
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
  return true;
}

function sendError(res, status, message) {
  if (res.headersSent || res.writableEnded) {
    console.warn('Attempted to send error after stream closed');
    return true;
  }
  sendJson(res, status, { code: status, message });
  return true;
}

/**
 * Generic error handler for route controllers
 */
function handleError(res, err, defaultStatus = 500) {
  const status = mapErrorToStatus(err, defaultStatus);
  const message = err?.message || 'Internal Server Error';
  console.error('Request error:', { status, message, stack: err?.stack });
  sendError(res, status, message);
}

module.exports = {
  mapErrorToStatus,
  sendJson,
  sendError,
  handleError,
};

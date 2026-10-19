const dataStore = require('../data-store');
const authService = require('../services/auth');
const emailService = require('../services/email');
const loginSession = require('../services/login-session');
const { parseBody, parseOptionalJsonBody } = require('../utils/parsers');
const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate, authenticateBearer } = require('../middleware/auth');
const {
  MEDIA_TOKEN_TTL_SECONDS,
  createMediaSessionToken,
  serializeMediaSessionCookie,
} = require('../services/media-session');
const {
  SCOPED_TOKEN_TTL_SECONDS,
  createGroupChatTicket,
} = require('../services/scoped-browser-token');

const GUEST_METADATA_MAX_BYTES = 8 * 1024;
const GUEST_METADATA_TIMEOUT_MS = 500;
const MEDIA_SESSION_REFRESH_AFTER_SECONDS = 600;

/**
 * Extract client IP from request headers or socket
 * @param {http.IncomingMessage} req - HTTP request object
 * @returns {string} Client IP address
 */
function readDeviceId(req, body) {
  const header = req.headers?.['x-linglish-device'];
  const value = Array.isArray(header) ? header[0] : header;
  return value || body?.device_id || body?.deviceId || null;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown');
}

function logWithTs(message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}
function warnWithTs(message) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] ${message}`);
}
function errorWithTs(message) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${message}`);
}

const PUBLIC_TRACK_EVENT_NAMES = new Set([
  'click',
  'today_plan_loaded',
  'reco_impression',
  'reco_click',
  'reco_feedback',
  'today_plan_error',
  'today_workspace_view',
  'today_guest_cta_click',
  'today_first_lesson_view',
  'today_first_lesson_start',
  'today_first_lesson_complete_view',
  'today_guest_first_lesson_start',
  'today_guest_first_lesson_ready',
  'today_guest_first_lesson_error',
  'first_lesson_entry_click',
  'first_lesson_guest_ready',
  'first_lesson_entry_ready',
  'first_lesson_entry_error',
  'first_lesson_ready',
  'first_lesson_playback_started',
  'first_lesson_sentence_completed',
  'first_lesson_ai_feedback_seen',
  'first_lesson_completed',
  'onboarding_started',
  'onboarding_entry_click',
  'onboarding_step_completed',
  'onboarding_result_view',
  'onboarding_save_plan_click',
  'onboarding_completed',
  'onboarding_skipped',
  'router_redirect',
  'auth_page_view',
  'auth_tab_switch',
  'auth_submit_attempt',
  'auth_submit_error',
  'auth_guest_click',
  'auth_reset_page_view',
  'auth_reset_request',
  'auth_reset_request_success',
  'auth_reset_request_error',
  'auth_reset_confirm',
  'auth_reset_confirm_success',
  'auth_reset_confirm_error',
  'auth_email_verify_page_view',
  'auth_email_verify_confirm',
  'auth_email_verify_success',
  'auth_email_verify_error',
  'auth_email_verify_resend',
  'auth_email_verify_resend_success',
  'auth_email_verify_resend_error',
  'auth_email_verify_banner_view',
  'auth_email_verify_banner_resend',
  'auth_email_verify_banner_dismiss',
  'pricing_page_view',
  'pricing_billing_toggle',
  'pricing_upgrade_click',
  'pricing_auth_required',
  'pricing_checkout_started',
  'pricing_checkout_error',
  'pricing_checkout_redirect',
  'pricing_success_view',
  'pricing_cancelled_view',
  'pricing_subscription_status_active',
  'pricing_subscription_status_pending',
  'pricing_subscription_status_error',
  'pricing_team_interest_click',
  'pricing_team_form_view',
  'pricing_team_form_submit',
  'pricing_team_form_success',
  'pricing_team_form_error',
]);

function sanitizeTrackingValue(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 300);
  return null;
}

function normalizeVisitorId(value) {
  if (typeof value !== 'string') return null;
  const visitorId = value.trim();
  return /^llv_[a-zA-Z0-9_-]{12,64}$/.test(visitorId) ? visitorId : null;
}

function buildGuestLoginProperties({ ip, userAgent, visitorId }) {
  const normalizedVisitorId = normalizeVisitorId(visitorId);
  return {
    ip,
    user_agent: userAgent,
    ...(normalizedVisitorId ? { visitor_id: normalizedVisitorId } : {}),
  };
}

function sanitizeTrackingProperties(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

  const properties = {};
  const entries = Object.entries(input).slice(0, 40);
  for (const [key, rawValue] of entries) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) continue;
    const value = sanitizeTrackingValue(rawValue);
    if (value !== undefined) properties[key] = value;
  }
  return properties;
}

function normalizeOnboardingProfileFields(input = {}) {
  const validLevels = new Set(['beginner', 'intermediate', 'advanced']);
  const level = validLevels.has(String(input.level || '').trim().toLowerCase())
    ? String(input.level).trim().toLowerCase()
    : null;
  const dailyGoal = input.daily_goal == null ? null : Number(input.daily_goal);
  const normalizedDailyGoal = Number.isFinite(dailyGoal) && dailyGoal >= 5 && dailyGoal <= 180
    ? Math.round(dailyGoal)
    : null;
  const interests = Array.isArray(input.interests)
    ? input.interests.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
    : (typeof input.interests === 'string' && input.interests.trim() ? [input.interests.trim()] : null);

  return {
    level,
    daily_goal: normalizedDailyGoal,
    interests: interests && interests.length ? interests : null,
  };
}

async function syncOnboardingProfile(userId, fields = {}) {
  if (!userId) return false;
  const updates = [];
  const values = [];
  let index = 1;

  if (fields.level) {
    updates.push(`current_vocabulary_level = $${index++}`);
    values.push(fields.level);
    updates.push('vocabulary_level_updated_at = NOW()');
  }
  if (fields.daily_goal != null) {
    updates.push(`daily_goal = $${index++}`);
    values.push(fields.daily_goal);
  }
  if (fields.interests) {
    updates.push(`interests = $${index++}`);
    values.push(fields.interests);
  }
  if (!updates.length) return false;

  await dataStore.query(
    `INSERT INTO user_profiles (user_id, created_at, updated_at)
     VALUES ($1, NOW(), NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  updates.push('updated_at = NOW()');
  values.push(userId);
  await dataStore.query(
    `UPDATE user_profiles
        SET ${updates.join(', ')}
      WHERE user_id = $${index}`,
    values
  );
  return true;
}

/**
 * Register and handle authentication routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - Parsed URL object
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerAuthRoutes(pathname, req, res, url) {
  // POST /auth/ws-ticket - exchange an account Bearer for a group-bound WebSocket ticket
  if (pathname === '/auth/ws-ticket' && req.method === 'POST') {
    try {
      const user = await authenticateBearer(req);
      const body = await parseBody(req);
      const groupId = Number(body?.group_id);
      if (!Number.isSafeInteger(groupId) || groupId <= 0) {
        return sendError(res, 400, 'INVALID_GROUP');
      }
      const ticket = createGroupChatTicket(user, groupId);
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 200, {
        ticket,
        expires_in: SCOPED_TOKEN_TTL_SECONDS,
      });
    } catch (err) {
      if (err?.status === 503) return sendError(res, 503, 'Service unavailable');
      const status = err?.message === 'INVALID_JSON' || err?.message === 'INVALID_GROUP'
        ? 400
        : mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // POST /auth/media-session - exchange an account credential for a scoped media cookie
  if (pathname === '/auth/media-session' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const issuedAt = Math.floor(Date.now() / 1_000);
      const token = createMediaSessionToken(user, { now: () => issuedAt });
      res.setHeader('Set-Cookie', serializeMediaSessionCookie(token));
      return sendJson(res, 200, {
        expires_at: new Date((issuedAt + MEDIA_TOKEN_TTL_SECONDS) * 1_000).toISOString(),
        ttl_seconds: MEDIA_TOKEN_TTL_SECONDS,
        refresh_after_seconds: MEDIA_SESSION_REFRESH_AFTER_SECONDS,
      });
    } catch (err) {
      if (err?.status === 503) {
        return sendError(res, 503, 'Service unavailable');
      }
      return sendError(res, mapErrorToStatus(err, 401), err.message);
    }
  }

  // DELETE /auth/media-session - safe to call after logout or during account switching
  if (pathname === '/auth/media-session' && req.method === 'DELETE') {
    res.setHeader('Set-Cookie', serializeMediaSessionCookie('', { maxAge: 0 }));
    return sendJson(res, 200, { ok: true });
  }

  // POST /auth/register
  if (pathname === '/auth/register' && req.method === 'POST') {
    const clientIp = getClientIp(req);

    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      errorWithTs(`[Auth] Register payload parse error from ${clientIp}: ${err?.message || err}`);
      return sendError(res, 400, err.message || 'INVALID_JSON');
    }

    const account = body?.account || body?.email || body?.phone || 'unknown';
    logWithTs(`[Auth] Register attempt account=${account} ip=${clientIp}`);

    try {
      const user = await authService.register(body);
      logWithTs(`[Auth] Register success account=${account} ip=${clientIp} user=${user.username || user.id}`);
      const issued = await authService.issueLoginCredentials(user, {
        deviceId: readDeviceId(req, body),
        provider: 'password',
      });
      let emailVerification = null;
      try {
        const onboardingFields = normalizeOnboardingProfileFields(body);
        const profileSynced = await syncOnboardingProfile(user.id, onboardingFields);
        await dataStore.recordLoginSession(user.id, clientIp, req.headers['user-agent'] || null);
        await dataStore.createEvent({
          user_id: user.id,
          event_time: new Date().toISOString(),
          event_name: 'user_register',
          properties: {
            ip: clientIp,
            user_agent: req.headers['user-agent'] || null,
            profile_synced: profileSynced,
            ...(onboardingFields.daily_goal != null ? { daily_goal: onboardingFields.daily_goal } : {}),
            ...(onboardingFields.interests ? { interests: onboardingFields.interests } : {}),
          },
          source: 'web',
        });
      } catch (e) {
        console.warn('[Auth] Failed to record registration session/profile:', e?.message || e);
      }
      try {
        emailVerification = await authService.requestEmailVerification(user.id, {
          ip: clientIp,
          userAgent: req.headers['user-agent'] || null,
        });
      } catch (e) {
        console.warn('[Auth] Failed to send registration email verification:', e?.message || e);
      }
      return sendJson(res, 201, {
        ...user,
        user,
        ...issued,
        is_new: true,
        email_verification: emailVerification,
      });
    } catch (err) {
      const status = err.message === 'EMAIL_ALREADY_EXISTS' || err.message === 'PHONE_ALREADY_EXISTS' ? 409 : 400;
      warnWithTs(`[Auth] Register failed account=${account} ip=${clientIp} status=${status} reason=${err?.message || err}`);
      return sendError(res, status, err.message);
    }
  }

  // POST /auth/login
  if (pathname === '/auth/login' && req.method === 'POST') {
    const clientIp = getClientIp(req);

    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      errorWithTs(`[Auth] Login payload parse error from ${clientIp}: ${err?.message || err}`);
      return sendError(res, 400, err.message || 'INVALID_JSON');
    }

    const account = body?.account || body?.email || body?.phone || 'unknown';
    const attemptStarted = Date.now();
    logWithTs(`[Auth] Login attempt account=${account} ip=${clientIp}`);

    try {
      const tokens = await authService.login(body, { deviceId: readDeviceId(req, body) });
      logWithTs(`[Auth] Login success account=${account} ip=${clientIp} elapsed=${Date.now() - attemptStarted}ms user_id=${tokens.user_id}`);
      try {
        await dataStore.recordLoginSession(tokens.user_id, clientIp, req.headers['user-agent'] || null);
        await dataStore.createEvent({
          user_id: tokens.user_id,
          event_time: new Date().toISOString(),
          event_name: 'user_login',
          properties: { ip: clientIp, user_agent: req.headers['user-agent'] || null },
          source: 'web',
        });
      } catch (e) {
        console.warn('[Auth] Failed to record login session:', e?.message || e);
      }
      return sendJson(res, 200, tokens);
    } catch (err) {
      const status = mapErrorToStatus(err, 401);
      warnWithTs(`[Auth] Login failed account=${account} ip=${clientIp} status=${status} reason=${err?.message || err}`);
      return sendError(res, status, err.message);
    }
  }

  // POST /auth/password-reset/request
  if (pathname === '/auth/password-reset/request' && req.method === 'POST') {
    const clientIp = getClientIp(req);

    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      errorWithTs(`[Auth] Password reset request payload parse error from ${clientIp}: ${err?.message || err}`);
      return sendError(res, 400, err.message || 'INVALID_JSON');
    }

    try {
      const result = await authService.requestPasswordReset(body, {
        ip: clientIp,
        userAgent: req.headers['user-agent'] || null,
      });
      logWithTs(`[Auth] Password reset requested ip=${clientIp} delivery_configured=${result.delivery_configured}`);
      return sendJson(res, 200, result);
    } catch (err) {
      const status = err.message === 'PASSWORD_RESET_ACCOUNT_REQUIRED' ? 400 : mapErrorToStatus(err, 400);
      warnWithTs(`[Auth] Password reset request failed ip=${clientIp} status=${status} reason=${err?.message || err}`);
      return sendError(res, status, err.message);
    }
  }

  // POST /auth/password-reset/confirm
  if (pathname === '/auth/password-reset/confirm' && req.method === 'POST') {
    const clientIp = getClientIp(req);

    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      errorWithTs(`[Auth] Password reset confirm payload parse error from ${clientIp}: ${err?.message || err}`);
      return sendError(res, 400, err.message || 'INVALID_JSON');
    }

    try {
      await authService.resetPassword(body, {
        ip: clientIp,
        userAgent: req.headers['user-agent'] || null,
      });
      logWithTs(`[Auth] Password reset completed ip=${clientIp}`);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      const status = err.message === 'INVALID_OR_EXPIRED_RESET_TOKEN' || err.message === 'INVALID_PASSWORD'
        ? 400
        : mapErrorToStatus(err, 400);
      warnWithTs(`[Auth] Password reset confirm failed ip=${clientIp} status=${status} reason=${err?.message || err}`);
      return sendError(res, status, err.message);
    }
  }

  // POST /auth/email-verification/request
  if (pathname === '/auth/email-verification/request' && req.method === 'POST') {
    const clientIp = getClientIp(req);
    try {
      const user = await authenticate(req);
      const result = await authService.requestEmailVerification(user.id, {
        ip: clientIp,
        userAgent: req.headers['user-agent'] || null,
      });
      logWithTs(`[Auth] Email verification requested user_id=${user.id} ip=${clientIp} delivery_configured=${result.delivery_configured}`);
      return sendJson(res, 200, result);
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      warnWithTs(`[Auth] Email verification request failed ip=${clientIp} status=${status} reason=${err?.message || err}`);
      return sendError(res, status, err.message);
    }
  }

  // POST /auth/email-verification/confirm
  if (pathname === '/auth/email-verification/confirm' && req.method === 'POST') {
    const clientIp = getClientIp(req);

    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      errorWithTs(`[Auth] Email verification payload parse error from ${clientIp}: ${err?.message || err}`);
      return sendError(res, 400, err.message || 'INVALID_JSON');
    }

    try {
      const result = await authService.verifyEmail(body, {
        ip: clientIp,
        userAgent: req.headers['user-agent'] || null,
      });
      logWithTs(`[Auth] Email verified user_id=${result.user_id} ip=${clientIp}`);
      return sendJson(res, 200, result);
    } catch (err) {
      const status = err.message === 'INVALID_OR_EXPIRED_EMAIL_VERIFICATION_TOKEN' ? 400 : mapErrorToStatus(err, 400);
      warnWithTs(`[Auth] Email verification failed ip=${clientIp} status=${status} reason=${err?.message || err}`);
      return sendError(res, status, err.message);
    }
  }

  // POST /auth/guest - 游客登录已关闭，避免未注册用户占用账号
  if (pathname === '/auth/guest' && req.method === 'POST') {
    return sendError(res, 403, 'GUEST_LOGIN_DISABLED');
  }

  // POST /auth/refresh - exchange the device session for a new 1-hour access credential
  if (pathname === '/auth/refresh' && req.method === 'POST') {
    let body = {};
    try {
      body = await parseBody(req);
    } catch (err) {
      return sendError(res, 400, err.message || 'INVALID_JSON');
    }
    try {
      const tokens = await authService.refreshLogin(body.refresh_token, readDeviceId(req, body));
      return sendJson(res, 200, tokens);
    } catch (err) {
      const status = err?.message === 'INVALID_TOKEN' || err?.message === 'GOOGLE_AUTHORIZATION_REVOKED'
        ? 401
        : mapErrorToStatus(err, 401);
      return sendError(res, status, err.message || 'TOKEN_EXPIRED');
    }
  }

  // POST /auth/logout — idempotent. An expired access credential can still revoke its session.
  if (pathname === '/auth/logout' && req.method === 'POST') {
    const clientIp = getClientIp(req);
    let body = {};
    try {
      body = await parseBody(req);
    } catch (_) {
      body = {};
    }
    try {
      const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const payload = authService.decodeToken(bearer) || authService.decodeToken(body.refresh_token);
      if (payload?.sid) await loginSession.revoke(payload.sid);
      if (payload?.sub) {
        try {
          await dataStore.recordLogoutSession(payload.sub);
          await dataStore.createEvent({
            user_id: payload.sub,
            event_time: new Date().toISOString(),
            event_name: 'user_logout',
            properties: { ip: clientIp, user_agent: req.headers['user-agent'] || null },
            source: 'web',
          });
        } catch (err) {
          warnWithTs('[Auth] Failed to record logout:' + (err?.message || err));
        }
      }
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 200, { ok: true });
    }
  }

  // GET /users/me
  if (pathname === '/users/me' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      // Surface whether the server can actually deliver verification email, so the
      // client never shows a "resend" prompt that can't succeed (delivery unconfigured).
      return sendJson(res, 200, {
        ...user,
        email_delivery_configured: emailService.isEmailDeliveryConfigured(),
      });
    } catch (err) {
      return sendError(res, 401, err.message);
    }
  }

  // POST /track/page-visit - 记录页面访问（无需认证，支持游客和注册用户）
  if (pathname === '/track/page-visit' && req.method === 'POST') {
    const clientIp = getClientIp(req);

    try {
      const body = await parseBody(req);
      const { page } = body;
      const visitorId = normalizeVisitorId(body?.visitor_id || body?.properties?.visitor_id);

      // 尝试获取用户信息（可选）
      let userId = null;
      let eventName = 'guest_visit';

      try {
        const user = await authenticate(req);
        if (user && user.id) {
          userId = user.id;
          eventName = 'page_visit';
        }
      } catch (err) {
        // 未登录用户，继续作为游客记录
      }

      // 记录访问事件
      await dataStore.createEvent({
        user_id: userId,
        event_time: new Date().toISOString(),
        event_name: eventName,
        properties: {
          ip: clientIp,
          page: page || 'index',
          ...(visitorId ? { visitor_id: visitorId } : {}),
          user_agent: req.headers['user-agent'] || null,
          referrer: req.headers['referer'] || req.headers['referrer'] || null,
        },
        source: 'web',
      });

      return sendJson(res, 200, { ok: true });
    } catch (err) {
      console.warn(`[Track] Failed to record page visit from ${clientIp}:`, err?.message || err);
      return sendError(res, 500, 'TRACKING_FAILED');
    }
  }

  // POST /track/event - 记录受限前端行为事件（无需认证，支持游客）
  if (pathname === '/track/event' && req.method === 'POST') {
    const clientIp = getClientIp(req);

    try {
      const body = await parseBody(req);
      const eventName = String(body?.event_name || '').trim();
      if (!PUBLIC_TRACK_EVENT_NAMES.has(eventName)) {
        return sendJson(res, 200, { ok: true, ignored: true });
      }
      const sanitizedProperties = sanitizeTrackingProperties(body?.properties);
      const visitorId = normalizeVisitorId(body?.visitor_id || sanitizedProperties.visitor_id);
      if (visitorId) sanitizedProperties.visitor_id = visitorId;
      else delete sanitizedProperties.visitor_id;

      let userId = null;
      try {
        const user = await authenticate(req);
        if (user && user.id) userId = user.id;
      } catch (err) {
        // 未登录用户，继续作为匿名事件记录
      }

      await dataStore.createEvent({
        user_id: userId,
        event_time: new Date().toISOString(),
        event_name: eventName,
        properties: {
          ...sanitizedProperties,
          ip: clientIp,
          user_agent: req.headers['user-agent'] || null,
        },
        source: 'web',
      });

      return sendJson(res, 200, { ok: true });
    } catch (err) {
      console.warn(`[Track] Failed to record event from ${clientIp}:`, err?.message || err);
      return sendError(res, 500, 'TRACKING_FAILED');
    }
  }

  // PUT /auth/profile - Update user profile (including level)
  if (pathname === '/auth/profile' && req.method === 'PUT') {
    const clientIp = getClientIp(req);

    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      errorWithTs(`[Auth] Profile update payload parse error from ${clientIp}: ${err?.message || err}`);
      return sendError(res, 400, err.message || 'INVALID_JSON');
    }

    try {
      const user = await authenticate(req);
      const { level, daily_goal, interests } = body;

      // Validate level
      const validLevels = ['beginner', 'intermediate', 'advanced'];
      if (level && !validLevels.includes(level)) {
        return sendError(res, 400, 'INVALID_LEVEL');
      }

      const dailyGoal = daily_goal == null ? null : Number(daily_goal);
      if (daily_goal != null && (!Number.isFinite(dailyGoal) || dailyGoal < 5 || dailyGoal > 180)) {
        return sendError(res, 400, 'INVALID_DAILY_GOAL');
      }

      const normalizedInterests = Array.isArray(interests)
        ? interests.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
        : (typeof interests === 'string' && interests.trim() ? [interests.trim()] : null);

      // Update user level in database
      if (level) {
        await dataStore.query(
          'UPDATE users SET level = $1, updated_at = NOW() WHERE id = $2',
          [level, user.id]
        );
      }

      // Keep user_profiles in sync for recommendations and first-day personalization.
      if (level || dailyGoal != null || normalizedInterests) {
        try {
          await dataStore.query(
            `INSERT INTO user_profiles (user_id, created_at, updated_at)
             VALUES ($1, NOW(), NOW())
             ON CONFLICT (user_id) DO NOTHING`,
            [user.id]
          );

          const fields = [];
          const values = [];
          let index = 1;
          if (level) {
            fields.push(`current_vocabulary_level = $${index++}`);
            values.push(level);
            fields.push(`vocabulary_level_updated_at = NOW()`);
          }
          if (dailyGoal != null) {
            fields.push(`daily_goal = $${index++}`);
            values.push(Math.round(dailyGoal));
          }
          if (normalizedInterests) {
            fields.push(`interests = $${index++}`);
            values.push(normalizedInterests);
          }
          fields.push('updated_at = NOW()');
          values.push(user.id);

          await dataStore.query(
            `UPDATE user_profiles
                SET ${fields.join(', ')}
              WHERE user_id = $${index}`,
            values
          );
        } catch (e) {
          console.warn('[Auth] Failed to sync user_profiles onboarding fields:', e?.message || e);
        }
        logWithTs(`[Auth] Profile update success user_id=${user.id} level=${level || '-'} daily_goal=${dailyGoal || '-'} ip=${clientIp}`);
      }

      // Get updated user
      const updatedUser = await dataStore.findUserById(user.id);
      const { password_hash, ...safeUser } = updatedUser;

      return sendJson(res, 200, { success: true, user: safeUser });
    } catch (err) {
      const status = mapErrorToStatus(err, 401);
      warnWithTs(`[Auth] Profile update failed ip=${clientIp} status=${status} reason=${err?.message || err}`);
      return sendError(res, status, err.message);
    }
  }

  // GET /auth/profile - Get user profile
  if (pathname === '/auth/profile' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const { password_hash, ...safeUser } = user;
      // Attach user_profiles.current_vocabulary_level when available
      try {
        if (dataStore.isDatabaseAvailable && dataStore.isDatabaseAvailable()) {
          const { pool } = require('../data-store/core');
          const r = await pool.query(
            'SELECT current_vocabulary_level, vocabulary_level_updated_at, daily_goal, interests FROM user_profiles WHERE user_id = $1',
            [user.id]
          );
          const profile = r.rows[0] || {};
          const lvl = profile.current_vocabulary_level;
          if (lvl && profile.vocabulary_level_updated_at) {
            safeUser.current_vocabulary_level = lvl;
            // Keep legacy `level` field aligned with current_vocabulary_level for clients.
            safeUser.level = lvl;
          }
          if (profile.daily_goal != null) safeUser.daily_goal = profile.daily_goal;
          if (profile.interests != null) safeUser.interests = profile.interests;
        }
      } catch (_) { }
      return sendJson(res, 200, { success: true, user: safeUser });
    } catch (err) {
      const status = mapErrorToStatus(err, 401);
      return sendError(res, status, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerAuthRoutes, buildGuestLoginProperties };

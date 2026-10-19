'use strict';

const { sendJson, sendError, mapErrorToStatus } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const { parseBody } = require('../utils/parsers');
const { canUseCoaching } = require('../services/entitlements');
const coaching = require('../services/coaching');

async function registerCoachingRoutes(pathname, req, res, url, dependencies = {}) {
  if (pathname !== '/api/coaching/sentence' || req.method !== 'POST') return false;
  const auth = dependencies.authenticate || authenticate;
  const readBody = dependencies.parseBody || parseBody;
  const respond = dependencies.sendJson || sendJson;
  const fail = dependencies.sendError || sendError;
  try {
    const user = await auth(req);
    if (!canUseCoaching(user)) {
      return respond(res, 402, {
        code: 'COACHING_MEMBERSHIP_REQUIRED',
        message: '带教模式仅对会员和高级会员开放',
        upgrade_url: '/pricing.html?from=coaching#plans',
      });
    }
    const body = await readBody(req);
    const action = String(body && body.action || '').trim();
    if (action === 'translate') {
      const result = await coaching.translateSentence(body.text, {
        translate: dependencies.translate,
      });
      return respond(res, 200, result);
    }
    if (action === 'explain') {
      const result = await coaching.explainSentence({
        text: body.text,
        translation: body.translation,
        word: body.word,
        userId: user && user.id,
      }, {
        model: dependencies.model,
        allowModel: typeof dependencies.model === 'function' ? true : dependencies.allowModel,
        strict: dependencies.strict === true,
      });
      return respond(res, 200, result);
    }
    return fail(res, 400, 'action 必须是 explain 或 translate');
  } catch (error) {
    const status = error.status || mapErrorToStatus(error, 400);
    return fail(res, status, error.message || '带教请求失败');
  }
}

module.exports = { registerCoachingRoutes };

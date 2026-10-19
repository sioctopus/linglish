(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishRoleplayApi = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const CANONICAL_DECIMAL_ID = /^[1-9]\d*$/;

  class RoleplayApiError extends Error {
    constructor(code, status, details = null) {
      super(code || 'AI_ROLEPLAY_ERROR');
      this.name = 'RoleplayApiError';
      this.code = code || 'AI_ROLEPLAY_ERROR';
      this.status = Number(status) || 0;
      this.details = details;
    }
  }

  function canonicalSessionId(id) {
    const value = String(id ?? '');
    return CANONICAL_DECIMAL_ID.test(value) ? value : null;
  }

  function boundedText(raw, maxLength) {
    return String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function createTurnDraftStore(options = {}) {
    const randomUUID = options.randomUUID
      || (() => globalThis.crypto && globalThis.crypto.randomUUID());
    let draft = null;

    function snapshot() {
      return draft ? { ...draft } : null;
    }

    function begin(transcript) {
      if (!draft) {
        draft = {
          transcript: boundedText(transcript, 1_000),
          turnKey: randomUUID(),
        };
      }
      return snapshot();
    }

    function resolve(turnKey) {
      if (draft && draft.turnKey === turnKey) draft = null;
    }

    function discard() {
      draft = null;
    }

    return { begin, current: snapshot, resolve, discard };
  }

  function abortError() {
    const error = new Error('ABORTED');
    error.name = 'AbortError';
    return error;
  }

  function createSpeechTurnRunner(options = {}) {
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    const serverTimeoutMs = Math.max(1, Number(options.serverTimeoutMs) || 8_000);
    const audioTimeoutMs = Math.max(1, Number(options.audioTimeoutMs) || 12_000);
    const synthesisTimeoutMs = Math.max(1, Number(options.synthesisTimeoutMs) || 10_000);

    function runStage(factory, timeoutMs, parentSignal) {
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        let settled = false;
        let timer = null;

        function cleanup() {
          if (timer) clearTimer(timer);
          timer = null;
          parentSignal?.removeEventListener('abort', onParentAbort);
        }

        function settle(callback, value) {
          if (settled) return;
          settled = true;
          cleanup();
          callback(value);
        }

        function onParentAbort() {
          controller.abort();
          settle(reject, abortError());
        }

        if (parentSignal?.aborted) {
          onParentAbort();
          return;
        }
        parentSignal?.addEventListener('abort', onParentAbort, { once: true });
        timer = setTimer(() => {
          controller.abort();
          const error = new Error('SPEECH_STAGE_TIMEOUT');
          error.code = 'SPEECH_STAGE_TIMEOUT';
          settle(reject, error);
        }, timeoutMs);

        Promise.resolve()
          .then(() => factory(controller.signal))
          .then((value) => settle(resolve, value), (error) => settle(reject, error));
      });
    }

    async function play(input = {}) {
      const generation = input.generation;
      const signal = input.signal;
      const isCurrent = typeof input.isCurrent === 'function' ? input.isCurrent : () => true;
      let played = false;
      try {
        if (signal?.aborted || !isCurrent(generation)) return false;
        let generated = null;
        try {
          generated = await runStage(input.generate, serverTimeoutMs, signal);
        } catch (_) { /* local speech fallback below */ }

        if (!signal?.aborted && isCurrent(generation) && generated?.audioUrl) {
          try {
            played = Boolean(await runStage(
              (stageSignal) => input.playAudio(generated.audioUrl, input.rate || 1, stageSignal),
              audioTimeoutMs,
              signal,
            ));
          } catch (_) { /* browser speech fallback below */ }
        }

        if (!played && !signal?.aborted && isCurrent(generation)) {
          try {
            played = Boolean(await runStage(
              (stageSignal) => input.synthesize(input.text, input.rate || 1, stageSignal),
              synthesisTimeoutMs,
              signal,
            ));
          } catch (_) { /* text-only mode */ }
        }
        return played;
      } finally {
        if (!signal?.aborted && isCurrent(generation) && typeof input.finish === 'function') {
          input.finish(generation);
        }
      }
    }

    return { play };
  }

  function createRoleplayApi(options = {}) {
    const requestFetch = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const getToken = options.getToken || (() => null);
    const randomUUID = options.randomUUID
      || (() => globalThis.crypto && globalThis.crypto.randomUUID());
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
    const maxPendingRetries = Number.isInteger(options.maxPendingRetries)
      ? Math.max(0, options.maxPendingRetries)
      : 5;

    if (typeof requestFetch !== 'function') throw new Error('FETCH_UNAVAILABLE');

    function authHeaders(json = false) {
      const headers = {};
      if (json) headers['Content-Type'] = 'application/json';
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      return headers;
    }

    async function parseResponse(response) {
      let body = null;
      try {
        body = await response.json();
      } catch (_) {
        body = null;
      }
      if (!response.ok) {
        throw new RoleplayApiError(body?.code || 'AI_ROLEPLAY_ERROR', response.status, body);
      }
      return body || {};
    }

    async function request(path, init = {}) {
      const response = await requestFetch(`${baseUrl}${path}`, init);
      return parseResponse(response);
    }

    async function listScenarios(filters = {}, signal) {
      const query = new URLSearchParams();
      if (filters.level) query.set('level', boundedText(filters.level, 2));
      if (filters.category) query.set('category', boundedText(filters.category, 40));
      if (filters.limit) query.set('limit', String(Math.max(1, Math.min(50, Number(filters.limit) || 12))));
      const suffix = query.toString() ? `?${query}` : '';
      return request(`/ai-roleplay/scenarios${suffix}`, {
        method: 'GET',
        headers: authHeaders(false),
        signal,
      });
    }

    async function startSession(input, signal) {
      return request('/ai-roleplay/sessions', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          scenario_id: boundedText(input?.scenario_id || input?.scenarioId, 80),
          cefr_level: boundedText(input?.cefr_level || input?.cefrLevel, 2),
          source: boundedText(input?.source || 'catalog', 80),
        }),
        signal,
      });
    }

    async function getSession(id, signal) {
      const sessionId = canonicalSessionId(id);
      if (!sessionId) throw new RoleplayApiError('SESSION_ID_INVALID', 400);
      return request(`/ai-roleplay/sessions/${sessionId}`, {
        method: 'GET',
        headers: authHeaders(false),
        signal,
      });
    }

    async function submitTurn(id, input = {}, signal) {
      const sessionId = canonicalSessionId(id);
      if (!sessionId) throw new RoleplayApiError('SESSION_ID_INVALID', 400);
      const turnKey = input.turn_key || input.turnKey || randomUUID();
      const payload = {
        turn_key: turnKey,
        transcript: boundedText(input.transcript, 1_000),
      };
      const assessmentId = canonicalSessionId(
        input.pronunciation_summary?.assessment_id || input.pronunciationSummary?.assessment_id,
      );
      if (assessmentId) payload.pronunciation_summary = { assessment_id: assessmentId };

      let pendingRetries = 0;
      while (true) {
        try {
          return await request(`/ai-roleplay/sessions/${sessionId}/turns`, {
            method: 'POST',
            headers: authHeaders(true),
            body: JSON.stringify(payload),
            signal,
          });
        } catch (error) {
          if (
            error.code !== 'TURN_IN_PROGRESS'
            || error.status !== 409
            || pendingRetries >= maxPendingRetries
          ) throw error;
          pendingRetries += 1;
          const retryAfter = Math.max(100, Math.min(2_000, Number(error.details?.retry_after_ms) || 600));
          await sleep(retryAfter);
        }
      }
    }

    async function completeSession(id, signal) {
      const sessionId = canonicalSessionId(id);
      if (!sessionId) throw new RoleplayApiError('SESSION_ID_INVALID', 400);
      return request(`/ai-roleplay/sessions/${sessionId}/complete`, {
        method: 'POST',
        headers: authHeaders(true),
        body: '{}',
        signal,
      });
    }

    async function transcribe(input = {}, signal) {
      return request('/ai-roleplay/transcribe', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          audio_data: input.audioData,
          duration_seconds: input.durationSeconds,
          language: 'en',
        }),
        signal,
      });
    }

    async function generateSpeech(text, signal) {
      return request('/tts/generate', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          text: boundedText(text, 600),
          lang: 'en',
          provider: 'edge',
          voice: (window.LinglishTtsVoice ? LinglishTtsVoice.current() : 'en-US-AvaMultilingualNeural'),
        }),
        signal,
      });
    }

    return {
      listScenarios,
      startSession,
      getSession,
      submitTurn,
      completeSession,
      transcribe,
      generateSpeech,
    };
  }

  return {
    RoleplayApiError,
    canonicalSessionId,
    createTurnDraftStore,
    createSpeechTurnRunner,
    createRoleplayApi,
  };
});

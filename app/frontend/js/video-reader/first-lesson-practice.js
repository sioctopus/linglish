(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishFirstLessonPractice = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function compact(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeSourceIndices(value, fallbackIndex) {
    const source = Array.isArray(value) ? value : [fallbackIndex];
    return Array.from(new Set(source.map(Number).filter((index) => Number.isInteger(index) && index >= 0)))
      .sort((left, right) => left - right);
  }

  function createAssessmentContext(options) {
    const input = options || {};
    const subject = compact(input.subject);
    const videoId = compact(input.videoId);
    const stableSegmentId = compact(input.stableSegmentId);
    const selectionGeneration = Number(input.selectionGeneration);
    const sourceIndices = normalizeSourceIndices(input.sourceIndices, input.displayIndex);
    if (!subject || !videoId || !stableSegmentId || !Number.isInteger(selectionGeneration) || !sourceIndices.length) {
      return null;
    }
    return Object.freeze({
      subject,
      videoId,
      stableSegmentId,
      sourceIndices: Object.freeze(sourceIndices),
      selectionGeneration,
      displayIndex: Number.isInteger(Number(input.displayIndex)) ? Number(input.displayIndex) : null,
    });
  }

  function assessmentContextMatches(captured, current) {
    if (!captured || !current) return false;
    return compact(captured.subject) === compact(current.subject)
      && compact(captured.videoId) === compact(current.videoId)
      && compact(captured.stableSegmentId) === compact(current.stableSegmentId)
      && Number(captured.selectionGeneration) === Number(current.selectionGeneration);
  }

  async function submitAssessment(options) {
    const config = options || {};
    const context = config.context;
    const isCurrent = typeof config.isContextCurrent === 'function'
      ? config.isContextCurrent
      : function () { return true; };
    if (!context || !config.blob || !config.blob.size || !isCurrent(context)) return null;
    const FormDataType = config.FormData || (typeof FormData !== 'undefined' ? FormData : null);
    if (!FormDataType || typeof config.fetch !== 'function') throw new Error('ASSESSMENT_RUNTIME_UNAVAILABLE');
    const formData = new FormDataType();
    formData.append('audio', config.blob, config.filename || 'first-lesson.webm');
    formData.append('videoId', context.videoId);
    formData.append('stableSegmentId', context.stableSegmentId);
    formData.append('sourceIndices', JSON.stringify(context.sourceIndices));
    if (context.displayIndex != null) formData.append('segmentIndex', String(context.displayIndex));
    if (!isCurrent(context)) return null;
    const response = await config.fetch(config.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: formData,
    });
    if (!isCurrent(context)) return null;
    const result = await response.json().catch(function () { return {}; });
    if (!isCurrent(context)) return null;
    if (!response.ok) throw new Error(result.message || 'AI 评估失败，请重试');
    if (compact(result.stableSegmentId) !== context.stableSegmentId) {
      throw new Error('ASSESSMENT_IDENTITY_MISMATCH');
    }
    result.__assessmentId = result.assessment_id || result.assessmentId
      || (response.headers && response.headers.get && response.headers.get('x-request-id'))
      || `assessment-${Date.now()}`;
    return result;
  }

  function createDesktopRecorderController(options) {
    const config = options || {};
    const MediaRecorderType = config.MediaRecorder;
    const setTimer = config.setTimeout || setTimeout;
    const clearTimer = config.clearTimeout || clearTimeout;
    const maxDurationMs = Math.max(1000, Number(config.maxDurationMs) || 20000);
    const stoppedTracks = new WeakSet();
    let cycle = null;
    let processing = Promise.resolve();
    let lifecycleToken = 0;

    function button(state) {
      if (typeof config.setButtonState === 'function') config.setButtonState(state);
    }

    function lock(value) {
      if (typeof config.lockPlayback === 'function') config.lockPlayback(Boolean(value));
    }

    function stopTracks(stream) {
      const tracks = stream && typeof stream.getTracks === 'function' ? stream.getTracks() : [];
      for (const track of tracks) {
        if (!track || stoppedTracks.has(track)) continue;
        stoppedTracks.add(track);
        try { track.stop(); } catch (_) { }
      }
    }

    function clearCycleTimer(current) {
      if (!current || current.timerId == null) return;
      clearTimer(current.timerId);
      current.timerId = null;
    }

    function contextIsCurrent(context) {
      return (!config.isActive || config.isActive())
        && (!config.isContextCurrent || config.isContextCurrent(context));
    }

    function owns(current) {
      return Boolean(current
        && cycle === current
        && current.lifecycleToken === lifecycleToken
        && !current.cancelled);
    }

    async function finishStopped(current) {
      if (!owns(current)) {
        stopTracks(current && current.stream);
        return null;
      }
      clearCycleTimer(current);
      stopTracks(current.stream);
      const chunks = current.chunks.splice(0);
      if (current.cancelled || !current.shouldAssess || !chunks.length || !contextIsCurrent(current.context)) {
        if (owns(current)) button('idle');
        if (owns(current)) lock(false);
        if (owns(current)) cycle = null;
        return null;
      }
      if (!owns(current)) return null;
      button('evaluating');
      try {
        if (!owns(current)) return null;
        const blob = config.createBlob
          ? config.createBlob(chunks, current.recorder.mimeType)
          : new Blob(chunks, { type: current.recorder.mimeType || 'audio/webm' });
        if (!owns(current) || !contextIsCurrent(current.context)) return null;
        const result = await config.assess(blob, current.context);
        if (!owns(current) || !result || !contextIsCurrent(current.context)) return null;
        const accepted = await config.accept(result, current.context);
        if (!owns(current) || !accepted || !contextIsCurrent(current.context)) return null;
        if (typeof config.renderFeedback === 'function' && owns(current)) {
          config.renderFeedback(accepted.feedback, accepted.snapshot, result);
        }
        if (!owns(current)) return null;
        if (!accepted.accepted) return accepted;
        lock(false);
        if (!owns(current)) return null;
        if (accepted.snapshot && accepted.snapshot.complete) {
          if (typeof config.complete === 'function' && owns(current)) {
            config.complete(accepted.snapshot, current.context);
          }
        } else if (typeof config.advance === 'function' && owns(current)) {
          config.advance(current.context, accepted.snapshot);
        }
        return accepted;
      } catch (error) {
        if (owns(current) && contextIsCurrent(current.context) && typeof config.onError === 'function') {
          config.onError(error);
        }
        return null;
      } finally {
        if (owns(current)) button('idle');
        if (owns(current)) lock(false);
        if (owns(current)) cycle = null;
      }
    }

    function stop(reason) {
      const current = cycle;
      if (!owns(current)) return false;
      current.shouldAssess = reason === 'manual' || reason === 'timeout';
      clearCycleTimer(current);
      if (current.recorder && current.recorder.state !== 'inactive') {
        // Do not stop tracks here — wait for the MediaRecorder "stop" event so
        // the final dataavailable chunk is not dropped on some browsers.
        current.recorder.stop();
      } else {
        stopTracks(current.stream);
      }
      return true;
    }

    function teardown() {
      lifecycleToken += 1;
      const current = cycle;
      cycle = null;
      if (current) {
        current.cancelled = true;
        current.shouldAssess = false;
        clearCycleTimer(current);
        if (current.recorder && current.recorder.state !== 'inactive') current.recorder.stop();
        stopTracks(current.stream);
        current.chunks.length = 0;
      }
      button('idle');
      lock(false);
      return true;
    }

    async function start(context) {
      if (cycle) teardown('restart');
      if (!contextIsCurrent(context) || typeof MediaRecorderType !== 'function') return false;
      const current = {
        lifecycleToken: lifecycleToken + 1,
        context,
        stream: null,
        recorder: null,
        chunks: [],
        timerId: null,
        cancelled: false,
        shouldAssess: false,
      };
      lifecycleToken = current.lifecycleToken;
      cycle = current;
      if (typeof config.pausePlayback === 'function') config.pausePlayback();
      lock(true);
      button('requesting');
      let stream = null;
      try {
        stream = await config.getUserMedia({ audio: true });
        if (!owns(current) || !contextIsCurrent(context)) {
          stopTracks(stream);
          return false;
        }
        current.stream = stream;
        if (!owns(current)) {
          stopTracks(stream);
          return false;
        }
        const recorder = new MediaRecorderType(stream);
        current.recorder = recorder;
        if (!owns(current)) {
          stopTracks(stream);
          return false;
        }
        recorder.addEventListener('dataavailable', function (event) {
          if (owns(current) && event && event.data && event.data.size) current.chunks.push(event.data);
        });
        recorder.addEventListener('stop', function () {
          if (!owns(current)) {
            stopTracks(current.stream);
            return;
          }
          processing = finishStopped(current);
        }, { once: true });
        recorder.addEventListener('error', function (event) {
          if (!owns(current)) {
            stopTracks(current.stream);
            return;
          }
          const error = event && event.error ? event.error : new Error('RECORDER_ERROR');
          if (typeof config.onError === 'function' && owns(current)) config.onError(error);
          if (!owns(current)) return;
          teardown('recorder-error');
        }, { once: true });
        if (!owns(current)) {
          stopTracks(stream);
          return false;
        }
        recorder.start();
        if (!owns(current)) {
          if (recorder.state !== 'inactive') recorder.stop();
          stopTracks(stream);
          return false;
        }
        try {
          if (typeof window !== 'undefined'
            && window.LinglishAudioCues
            && typeof window.LinglishAudioCues.playMicReadyCue === 'function') {
            window.LinglishAudioCues.playMicReadyCue();
          }
        } catch (_) {}
        current.timerId = setTimer(function () {
          if (owns(current)) stop('timeout');
        }, maxDurationMs);
        if (!owns(current)) {
          clearCycleTimer(current);
          if (recorder.state !== 'inactive') recorder.stop();
          stopTracks(stream);
          return false;
        }
        button('recording');
        return true;
      } catch (error) {
        stopTracks(stream);
        if (!owns(current)) return false;
        clearCycleTimer(current);
        if (typeof config.onError === 'function') config.onError(error);
        if (owns(current)) button('idle');
        if (owns(current)) lock(false);
        if (owns(current)) cycle = null;
        return false;
      }
    }

    return {
      start,
      stop,
      teardown,
      isRecording() { return Boolean(cycle && cycle.recorder && cycle.recorder.state === 'recording'); },
      whenIdle() { return processing; },
    };
  }

  return {
    normalizeSourceIndices,
    createAssessmentContext,
    assessmentContextMatches,
    submitAssessment,
    createDesktopRecorderController,
  };
});

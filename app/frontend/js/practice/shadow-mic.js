/**
 * Reliable short-form mic capture for shadowing / 跟读.
 * Mobile Safari needs the mic stream opened inside the tap gesture, then
 * recording can start after the model sentence finishes. Prefer audio/mp4 on
 * Apple so the blob actually plays back.
 *
 * Quiet speech: disable noise-gate style processing, force AGC, unmute tracks,
 * and boost through Web Audio before MediaRecorder.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishShadowMic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const DESKTOP_TYPES = Object.freeze([
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
    'audio/ogg;codecs=opus',
  ]);

  const APPLE_TYPES = Object.freeze([
    'audio/mp4',
    'audio/aac',
    'audio/mpeg',
    'audio/webm;codecs=opus',
    'audio/webm',
  ]);

  // Default: sensitive for shadowing. noiseSuppression gates quiet speech;
  // echoCancellation often ducks the learner after model audio on phones.
  const AUDIO_CONSTRAINTS = Object.freeze({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    },
    video: false,
  });

  const SIMPLE_AUDIO = Object.freeze({ audio: true, video: false });

  function userAgent() {
    try {
      return String((root && root.navigator && root.navigator.userAgent) || '');
    } catch (_) {
      return '';
    }
  }

  function isAppleMedia(ua) {
    const text = String(ua == null ? userAgent() : ua);
    if (/iPhone|iPad|iPod/i.test(text)) return true;
    try {
      if (root && root.navigator && root.navigator.platform === 'MacIntel'
        && Number(root.navigator.maxTouchPoints) > 1) {
        return true;
      }
    } catch (_) { /* ignore */ }
    const safari = /Safari/i.test(text) && !/Chrome|CriOS|Chromium|FxiOS|EdgiOS|OPR|Android/i.test(text);
    return Boolean(safari);
  }

  function isWeChatBrowser(ua) {
    return /MicroMessenger/i.test(String(ua == null ? userAgent() : ua));
  }

  const MIC_DEVICE_KEY = 'linglish.shadowMic.deviceId';

  function sensitiveConstraints(ua) {
    const apple = isAppleMedia(ua);
    const wechat = isWeChatBrowser(ua);
    return {
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        // Hint higher fidelity when the engine honors it.
        sampleRate: apple || wechat ? 44100 : 48000,
      },
      video: false,
    };
  }

  function getPreferredMicId(storage) {
    try {
      const store = storage || (root && root.localStorage);
      const id = store && store.getItem(MIC_DEVICE_KEY);
      return id ? String(id) : '';
    } catch (_) {
      return '';
    }
  }

  function setPreferredMicId(deviceId, storage) {
    try {
      const store = storage || (root && root.localStorage);
      if (!store) return false;
      if (!deviceId) store.removeItem(MIC_DEVICE_KEY);
      else store.setItem(MIC_DEVICE_KEY, String(deviceId));
      return true;
    } catch (_) {
      return false;
    }
  }

  function cloneConstraints(constraints) {
    if (!constraints) return { audio: {}, video: false };
    try {
      return JSON.parse(JSON.stringify(constraints));
    } catch (_) {
      return { audio: true, video: false };
    }
  }

  /**
   * Attach a concrete input device (lav / headset / USB / BT mic).
   * Pass deviceId '' to use the system default.
   */
  function applyPreferredDevice(constraints, deviceId) {
    const id = deviceId == null ? getPreferredMicId() : String(deviceId || '');
    const next = cloneConstraints(constraints || sensitiveConstraints());
    if (next.audio === true) next.audio = {};
    if (!next.audio || typeof next.audio !== 'object') next.audio = {};
    if (id) next.audio.deviceId = { exact: id };
    else if (next.audio.deviceId) delete next.audio.deviceId;
    next.video = false;
    return next;
  }

  function shortenDeviceLabel(label, index) {
    const text = String(label || '').trim();
    if (text) return text;
    return `麦克风 ${Number(index) + 1}`;
  }

  async function listAudioInputs(options) {
    const config = options || {};
    const mediaDevices = config.mediaDevices
      || (root && root.navigator && root.navigator.mediaDevices)
      || null;
    if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') {
      return [];
    }
    if (config.warm) {
      try {
        const warm = await acquireMic({
          getUserMedia: config.getUserMedia,
          mediaDevices,
          constraints: config.constraints,
          userAgent: config.userAgent,
          deviceId: '',
        });
        stopTracks(warm);
      } catch (_) { /* labels may stay empty without permission */ }
    }
    let devices = [];
    try {
      devices = await mediaDevices.enumerateDevices();
    } catch (_) {
      return [];
    }
    const preferred = getPreferredMicId(config.storage);
    const inputs = [];
    for (let i = 0; i < devices.length; i += 1) {
      const device = devices[i];
      if (!device || device.kind !== 'audioinput') continue;
      inputs.push({
        deviceId: String(device.deviceId || ''),
        label: shortenDeviceLabel(device.label, inputs.length),
        groupId: String(device.groupId || ''),
        preferred: Boolean(preferred && preferred === device.deviceId),
      });
    }
    return inputs;
  }

  function defaultBoostGain(ua) {
    if (isWeChatBrowser(ua)) return 4.5;
    if (isAppleMedia(ua)) return 3.5;
    return 2.75;
  }

  function recordingSupport(options) {
    const config = options || {};
    const MediaRecorderCtor = Object.prototype.hasOwnProperty.call(config, 'MediaRecorder')
      ? config.MediaRecorder
      : (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
    const getUserMedia = Object.prototype.hasOwnProperty.call(config, 'getUserMedia')
      ? config.getUserMedia
      : resolveGetUserMedia(config);
    const wechat = isWeChatBrowser(config.userAgent);
    let secure = true;
    if (Object.prototype.hasOwnProperty.call(config, 'secure')) {
      secure = Boolean(config.secure);
    } else if (root && root.isSecureContext === false
      && root.location
      && root.location.hostname !== 'localhost'
      && root.location.hostname !== '127.0.0.1') {
      secure = false;
    }
    const ok = Boolean(typeof MediaRecorderCtor === 'function' && typeof getUserMedia === 'function' && secure);
    let reason = '';
    if (!secure) reason = 'MICROPHONE_INSECURE';
    else if (typeof getUserMedia !== 'function') reason = 'MICROPHONE_UNAVAILABLE';
    else if (typeof MediaRecorderCtor !== 'function') reason = 'RECORDING_UNAVAILABLE';
    return {
      ok,
      wechat,
      secure,
      hasGetUserMedia: typeof getUserMedia === 'function',
      hasMediaRecorder: typeof MediaRecorderCtor === 'function',
      reason,
      hint: !ok
        ? (wechat
          ? '当前微信不支持网页录音。请点右上角 ···，选“在浏览器打开”后再跟读。'
          : '当前浏览器不能录音，请换 Safari / Chrome。')
        : (wechat
          ? '微信内录音不稳定。若无声或没权限，点右上角 ··· 用浏览器打开更稳。'
          : ''),
    };
  }

  function errorHint(error, options) {
    const code = error && error.code;
    const wechat = isWeChatBrowser((options && options.userAgent) || null);
    if (code === 'MICROPHONE_DENIED') {
      return wechat
        ? '请允许麦克风。若没有弹窗，点右上角 ··· 用浏览器打开。'
        : '没有麦克风权限：请在系统设置里允许，再回来点跟读';
    }
    if (code === 'MICROPHONE_INSECURE') {
      return wechat
        ? '微信打开的不是安全链接，无法开麦。请用 https 链接，或点 ··· 用浏览器打开。'
        : '当前页面不是安全连接，无法开麦';
    }
    if (code === 'EMPTY_RECORDING') {
      return wechat
        ? '还是没录到。请靠近嘴轻声再说；仍不行就点 ··· 用浏览器打开。'
        : '没录到声音，请靠近麦克风轻声再说一次';
    }
    if (code === 'RECORDING_UNAVAILABLE' || code === 'MICROPHONE_UNAVAILABLE') {
      return wechat
        ? '当前微信版本不支持网页录音。请点右上角 ···，用 Safari / Chrome 打开。'
        : '这个浏览器不能录音，请换 Safari / Chrome';
    }
    return wechat
      ? '微信录音失败。请再试一次，或点右上角 ··· 用浏览器打开。'
      : ((error && error.message) || '录音失败，请再试一次');
  }

  function preferredTypes(ua) {
    return isAppleMedia(ua) ? APPLE_TYPES : DESKTOP_TYPES;
  }

  function pickMimeType(MediaRecorderCtor, ua) {
    if (!MediaRecorderCtor || typeof MediaRecorderCtor.isTypeSupported !== 'function') return '';
    const types = preferredTypes(ua);
    for (let i = 0; i < types.length; i += 1) {
      const type = types[i];
      try {
        if (MediaRecorderCtor.isTypeSupported(type)) return type;
      } catch (_) { /* continue */ }
    }
    return '';
  }

  function defaultTimeslice(ua) {
    return isAppleMedia(ua) ? 0 : 250;
  }

  function stopTracks(stream) {
    const tracks = stream && typeof stream.getTracks === 'function' ? stream.getTracks() : [];
    for (let i = 0; i < tracks.length; i += 1) {
      try { tracks[i].stop(); } catch (_) { /* ignore */ }
    }
  }

  function prepareMicTracks(stream) {
    const tracks = stream && typeof stream.getAudioTracks === 'function'
      ? stream.getAudioTracks()
      : (stream && typeof stream.getTracks === 'function' ? stream.getTracks() : []);
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      try { track.enabled = true; } catch (_) { /* ignore */ }
      try {
        if (typeof track.applyConstraints === 'function') {
          track.applyConstraints({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: true,
          }).catch(() => {});
        }
      } catch (_) { /* ignore */ }
    }
    return stream;
  }

  /**
   * Amplify quiet speech for MediaRecorder. Falls back to the raw stream.
   */
  function boostMicStream(stream, options) {
    const config = options || {};
    const AudioCtx = config.AudioContext
      || (root && (root.AudioContext || root.webkitAudioContext))
      || null;
    if (!stream || !AudioCtx) {
      return { stream, rawStream: stream, boosted: false, close() {} };
    }
    let ctx = null;
    let source = null;
    let gainNode = null;
    let compressor = null;
    let dest = null;
    let monitorId = null;
    const setTimer = config.setInterval || setInterval;
    const clearTimer = config.clearInterval || clearInterval;
    const initialGain = Math.max(1, Number(config.gain) || 3);
    const maxGain = Math.max(initialGain, Number(config.maxGain) || 8);

    try {
      ctx = new AudioCtx();
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try { ctx.resume(); } catch (_) { /* ignore */ }
      }
      source = ctx.createMediaStreamSource(stream);
      gainNode = ctx.createGain();
      gainNode.gain.value = initialGain;
      // Mild compression lifts whispers without harsh clipping on loud takes.
      compressor = ctx.createDynamicsCompressor();
      try {
        compressor.threshold.value = -42;
        compressor.knee.value = 24;
        compressor.ratio.value = 3.5;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;
      } catch (_) { /* ignore */ }
      dest = ctx.createMediaStreamDestination();
      source.connect(gainNode);
      gainNode.connect(compressor);
      compressor.connect(dest);

      // Auto-raise gain while input stays very quiet.
      if (typeof ctx.createAnalyser === 'function') {
        const analyser = ctx.createAnalyser();
        if (analyser && typeof analyser.getByteTimeDomainData === 'function') {
          analyser.fftSize = 2048;
          try { gainNode.connect(analyser); } catch (_) { /* optional monitor */ }
          const data = new Uint8Array(analyser.fftSize || 2048);
          let checks = 0;
          monitorId = setTimer(() => {
            if (!gainNode || !analyser) return;
            try {
              analyser.getByteTimeDomainData(data);
            } catch (_) { return; }
            let peak = 0;
            for (let i = 0; i < data.length; i += 1) {
              const deviation = Math.abs(data[i] - 128);
              if (deviation > peak) peak = deviation;
            }
            checks += 1;
            // peak < 6 ≈ near-silence / very soft; keep lifting gently.
            if (peak < 6 && gainNode.gain.value < maxGain) {
              gainNode.gain.value = Math.min(maxGain, gainNode.gain.value * 1.35);
            } else if (peak < 14 && gainNode.gain.value < maxGain && checks < 12) {
              gainNode.gain.value = Math.min(maxGain, gainNode.gain.value * 1.15);
            }
          }, 180);
        }
      }

      return {
        stream: dest.stream,
        rawStream: stream,
        boosted: true,
        context: ctx,
        gainNode,
        close() {
          if (monitorId != null) {
            try { clearTimer(monitorId); } catch (_) { /* ignore */ }
            monitorId = null;
          }
          try { if (source) source.disconnect(); } catch (_) { /* ignore */ }
          try { if (gainNode) gainNode.disconnect(); } catch (_) { /* ignore */ }
          try { if (compressor) compressor.disconnect(); } catch (_) { /* ignore */ }
          try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch (_) { /* ignore */ }
          source = null;
          gainNode = null;
          compressor = null;
          dest = null;
          ctx = null;
        },
      };
    } catch (_) {
      try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch (__){ /* ignore */ }
      return { stream, rawStream: stream, boosted: false, close() {} };
    }
  }

  function clampDurationMs(value, fallback, maxMs) {
    const n = Number(value);
    const cap = Number.isFinite(Number(maxMs)) ? Number(maxMs) : 60000;
    if (!Number.isFinite(n)) return Math.min(cap, Math.max(1800, Number(fallback) || 5500));
    return Math.min(cap, Math.max(1800, Math.round(n)));
  }

  function resolveGetUserMedia(config) {
    if (typeof config.getUserMedia === 'function') return config.getUserMedia;
    const mediaDevices = config.mediaDevices
      || (root && root.navigator && root.navigator.mediaDevices)
      || null;
    if (mediaDevices && typeof mediaDevices.getUserMedia === 'function') {
      return (constraints) => mediaDevices.getUserMedia(constraints);
    }
    const legacy = root && root.navigator
      && (root.navigator.getUserMedia
        || root.navigator.webkitGetUserMedia
        || root.navigator.mozGetUserMedia);
    if (typeof legacy === 'function') {
      return (constraints) => new Promise((resolve, reject) => {
        legacy.call(root.navigator, constraints, resolve, reject);
      });
    }
    return null;
  }

  /**
   * Open the mic immediately (must stay inside the user-gesture turn on iOS).
   */
  async function acquireMic(options) {
    const config = options || {};
    const getUserMedia = resolveGetUserMedia(config);
    if (typeof getUserMedia !== 'function') {
      throw Object.assign(new Error('MICROPHONE_UNAVAILABLE'), { code: 'MICROPHONE_UNAVAILABLE' });
    }
    if (root && root.isSecureContext === false
      && root.location
      && root.location.hostname !== 'localhost'
      && root.location.hostname !== '127.0.0.1') {
      throw Object.assign(new Error('MICROPHONE_INSECURE'), { code: 'MICROPHONE_INSECURE' });
    }
    const ua = config.userAgent || userAgent();
    const preferredId = Object.prototype.hasOwnProperty.call(config, 'deviceId')
      ? String(config.deviceId || '')
      : getPreferredMicId(config.storage);
    const base = config.constraints || sensitiveConstraints(ua);
    const primary = applyPreferredDevice(base, preferredId);
    try {
      const stream = await getUserMedia(primary);
      return prepareMicTracks(stream);
    } catch (firstError) {
      const denied = firstError && (firstError.name === 'NotAllowedError' || firstError.name === 'PermissionDeniedError');
      if (denied) {
        throw Object.assign(new Error('MICROPHONE_DENIED'), {
          code: 'MICROPHONE_DENIED',
          cause: firstError,
        });
      }
      try {
        // Device unplugged / overconstrained: retry without exact deviceId, then plain audio.
        let stream;
        try {
          stream = await getUserMedia(applyPreferredDevice(AUDIO_CONSTRAINTS, ''));
        } catch (_) {
          stream = await getUserMedia(SIMPLE_AUDIO);
        }
        return prepareMicTracks(stream);
      } catch (secondError) {
        const deniedAgain = secondError && (secondError.name === 'NotAllowedError' || secondError.name === 'PermissionDeniedError');
        throw Object.assign(
          new Error(deniedAgain ? 'MICROPHONE_DENIED' : 'MICROPHONE_UNAVAILABLE'),
          {
            code: deniedAgain ? 'MICROPHONE_DENIED' : 'MICROPHONE_UNAVAILABLE',
            cause: secondError || firstError,
          },
        );
      }
    }
  }

  /**
   * Record until stop() is called, maxDuration elapses, or signal aborts.
   * Pass `stream` when the mic was already opened inside the tap gesture.
   */
  function recordShadow(options) {
    const config = options || {};
    const MediaRecorderCtor = config.MediaRecorder
      || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
    const getUserMedia = resolveGetUserMedia(config);
    const setTimer = config.setTimeout || setTimeout;
    const clearTimer = config.clearTimeout || clearTimeout;
    const now = config.now || Date.now;
    const minBytes = Math.max(1, Number(config.minBytes) || 16);
    const ua = config.userAgent || userAgent();
    const timeslice = config.timeslice != null
      ? Math.max(0, Number(config.timeslice) || 0)
      : defaultTimeslice(ua);
    const maxDurationMs = clampDurationMs(config.maxDurationMs, 8000);
    const releaseStream = config.releaseStream !== false;
    const wantBoost = config.boost !== false;

    if (typeof MediaRecorderCtor !== 'function') {
      return Promise.reject(Object.assign(new Error('RECORDING_UNAVAILABLE'), { code: 'RECORDING_UNAVAILABLE' }));
    }
    if (!config.stream && typeof getUserMedia !== 'function') {
      return Promise.reject(Object.assign(new Error('RECORDING_UNAVAILABLE'), { code: 'RECORDING_UNAVAILABLE' }));
    }

    let rawStream = config.stream || null;
    let stream = null;
    let ownsStream = !config.stream;
    let boostHandle = null;
    let recorder = null;
    let timerId = null;
    let startedAt = 0;
    let settled = false;
    let cancelRequested = false;
    const chunks = [];
    let resolveStop = null;
    const stopGate = new Promise((resolve) => { resolveStop = resolve; });

    function releaseAll() {
      try { if (boostHandle && typeof boostHandle.close === 'function') boostHandle.close(); } catch (_) { /* ignore */ }
      boostHandle = null;
      if (ownsStream || releaseStream) {
        stopTracks(rawStream);
        if (stream && stream !== rawStream) stopTracks(stream);
      }
      rawStream = null;
      stream = null;
    }

    function finish(kind, payload) {
      if (settled) return;
      settled = true;
      if (timerId != null) {
        clearTimer(timerId);
        timerId = null;
      }
      releaseAll();
      recorder = null;
      if (kind === 'error') {
        payload.reject(payload.error);
        return;
      }
      if (kind === 'cancel') {
        payload.resolve(null);
        return;
      }
      const mimeType = payload.mimeType || 'audio/mp4';
      const blob = new Blob(chunks, { type: mimeType });
      if (!blob.size || blob.size < minBytes) {
        payload.reject(Object.assign(new Error('EMPTY_RECORDING'), { code: 'EMPTY_RECORDING' }));
        return;
      }
      payload.resolve({
        blob,
        mimeType,
        durationMs: Math.max(0, now() - startedAt),
        boosted: Boolean(payload.boosted),
      });
    }

    function requestRecorderStop() {
      if (!recorder || recorder.state === 'inactive') {
        resolveStop();
        return;
      }
      try {
        if (typeof recorder.requestData === 'function' && recorder.state === 'recording') {
          try { recorder.requestData(); } catch (_) { /* optional */ }
        }
        recorder.stop();
      } catch (_) {
        resolveStop();
      }
    }

    function requestStop() {
      if (settled) return stopGate;
      requestRecorderStop();
      return stopGate;
    }

    function cancel() {
      cancelRequested = true;
      return requestStop();
    }

    function beginWithStream(acquired, bag) {
      if (settled || cancelRequested) {
        if (ownsStream || releaseStream) stopTracks(acquired);
        finish('cancel', bag);
        return;
      }
      rawStream = prepareMicTracks(acquired);
      if (wantBoost) {
        boostHandle = boostMicStream(rawStream, {
          gain: config.gain != null ? config.gain : defaultBoostGain(ua),
          maxGain: config.maxGain != null ? config.maxGain : 9,
          AudioContext: config.AudioContext,
          setInterval: config.setInterval,
          clearInterval: config.clearInterval,
        });
        stream = (boostHandle && boostHandle.stream) || rawStream;
        bag.boosted = Boolean(boostHandle && boostHandle.boosted);
      } else {
        stream = rawStream;
        bag.boosted = false;
      }

      const mimeType = pickMimeType(MediaRecorderCtor, ua);
      const recorderOpts = mimeType ? { mimeType } : undefined;
      if (recorderOpts && Number(config.audioBitsPerSecond) > 0) {
        recorderOpts.audioBitsPerSecond = Number(config.audioBitsPerSecond);
      } else if (recorderOpts) {
        // Prefer a roomy bitrate so soft speech isn't quantized away.
        recorderOpts.audioBitsPerSecond = isAppleMedia(ua) ? 128000 : 96000;
      }

      try {
        recorder = recorderOpts
          ? new MediaRecorderCtor(stream, recorderOpts)
          : new MediaRecorderCtor(stream);
      } catch (error) {
        // Retry without bitrate / with raw stream if boosted graph is rejected.
        try {
          if (boostHandle && boostHandle.boosted) {
            try { boostHandle.close(); } catch (_) { /* ignore */ }
            boostHandle = null;
            stream = rawStream;
            bag.boosted = false;
          }
          recorder = mimeType
            ? new MediaRecorderCtor(stream, { mimeType })
            : new MediaRecorderCtor(stream);
        } catch (error2) {
          finish('error', {
            reject: bag.reject,
            error: Object.assign(new Error('RECORDING_UNAVAILABLE'), {
              code: 'RECORDING_UNAVAILABLE',
              cause: error2 || error,
            }),
          });
          return;
        }
      }
      bag.mimeType = mimeType || recorder.mimeType || (isAppleMedia(ua) ? 'audio/mp4' : 'audio/webm');

      const onData = (event) => {
        if (event && event.data && event.data.size > 0) chunks.push(event.data);
      };
      const onStop = () => resolveStop();
      const onError = () => {
        finish('error', {
          reject: bag.reject,
          error: Object.assign(new Error('RECORDING_FAILED'), { code: 'RECORDING_FAILED' }),
        });
      };

      if (typeof recorder.addEventListener === 'function') {
        recorder.addEventListener('dataavailable', onData);
        recorder.addEventListener('stop', onStop, { once: true });
        recorder.addEventListener('error', onError, { once: true });
      } else {
        recorder.ondataavailable = onData;
        recorder.onstop = onStop;
        recorder.onerror = onError;
      }

      try {
        if (timeslice > 0) recorder.start(timeslice);
        else recorder.start();
      } catch (error) {
        finish('error', {
          reject: bag.reject,
          error: Object.assign(new Error('RECORDING_FAILED'), { code: 'RECORDING_FAILED', cause: error }),
        });
        return;
      }

      startedAt = now();
      if (typeof config.onReady === 'function') {
        try {
          config.onReady({
            mimeType: bag.mimeType,
            stop: requestStop,
            cancel,
            boosted: bag.boosted,
          });
        } catch (_) { /* ignore */ }
      }

      timerId = setTimer(() => {
        requestStop();
      }, maxDurationMs);

      stopGate.then(() => {
        if (cancelRequested) finish('cancel', bag);
        else finish('ok', bag);
      });
    }

    return new Promise((resolve, reject) => {
      const bag = { resolve, reject, mimeType: '', boosted: false };

      if (config.signal && typeof config.signal.addEventListener === 'function') {
        if (config.signal.aborted) cancelRequested = true;
        else config.signal.addEventListener('abort', () => { cancel(); }, { once: true });
      }

      if (rawStream) {
        ownsStream = false;
        beginWithStream(rawStream, bag);
        return;
      }

      acquireMic({
        getUserMedia,
        mediaDevices: config.mediaDevices,
        constraints: config.constraints,
        userAgent: ua,
      }).then((acquired) => {
        ownsStream = true;
        beginWithStream(acquired, bag);
      }).catch((error) => {
        finish('error', {
          reject,
          error: error && error.code
            ? error
            : Object.assign(new Error('MICROPHONE_UNAVAILABLE'), {
              code: 'MICROPHONE_UNAVAILABLE',
              cause: error,
            }),
        });
      });
    });
  }

  function recordingDurationMs(segment) {
    const start = Number(segment && (segment.start ?? segment.startTime));
    const end = Number(segment && (segment.end ?? segment.endTime));
    const span = Number.isFinite(start) && Number.isFinite(end) ? (end - start) * 1000 : 0;
    return clampDurationMs(span + 1200, 5500);
  }

  return {
    AUDIO_CONSTRAINTS,
    SIMPLE_AUDIO,
    MIC_DEVICE_KEY,
    PREFERRED_TYPES: DESKTOP_TYPES,
    APPLE_TYPES,
    isAppleMedia,
    isWeChatBrowser,
    preferredTypes,
    pickMimeType,
    defaultTimeslice,
    defaultBoostGain,
    sensitiveConstraints,
    getPreferredMicId,
    setPreferredMicId,
    applyPreferredDevice,
    listAudioInputs,
    prepareMicTracks,
    boostMicStream,
    stopTracks,
    clampDurationMs,
    recordingDurationMs,
    recordingSupport,
    errorHint,
    acquireMic,
    recordShadow,
  };
});

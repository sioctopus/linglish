/**
 * Persist Hold-to-record practice audio in the browser for a short TTL.
 * Same video + sentence overwrites the previous take. Default keep: 7 days.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LinglishShadowRecordingCacheApi = api;
    root.LinglishShadowRecordingCache = api.createShadowRecordingCache(root);
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const DATABASE_NAME = 'linglish-shadow-recordings';
  const OBJECT_STORE_NAME = 'recordings';
  const RECORD_VERSION = 1;
  const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function nowMs(environment) {
    const DateObject = (environment && environment.Date) || Date;
    return typeof DateObject.now === 'function' ? DateObject.now() : Date.now();
  }

  function makeId(videoId, segmentIndex) {
    return `${String(videoId)}::${Number(segmentIndex)}`;
  }

  function normalizeRecord(input, environment, ttlMs) {
    const videoId = input && input.videoId != null ? String(input.videoId).trim() : '';
    const segmentIndex = Number(input && input.segmentIndex);
    const blob = input && input.blob;
    if (!videoId || !Number.isFinite(segmentIndex) || segmentIndex < 0) return null;
    if (!blob) return null;
    const savedAt = Number.isFinite(Number(input.savedAt)) ? Number(input.savedAt) : nowMs(environment);
    const expiresAt = Number.isFinite(Number(input.expiresAt))
      ? Number(input.expiresAt)
      : (savedAt + ttlMs);
    return {
      id: makeId(videoId, segmentIndex),
      version: RECORD_VERSION,
      videoId,
      segmentIndex: Math.floor(segmentIndex),
      blob,
      mimeType: String((input && input.mimeType) || blob.type || 'audio/webm'),
      savedAt,
      expiresAt,
    };
  }

  function isFresh(record, at) {
    if (!record || !record.blob) return false;
    const expiresAt = Number(record.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > at;
  }

  function createMemoryStore(seed) {
    const map = new Map();
    if (Array.isArray(seed)) {
      seed.forEach((row) => {
        if (row && row.id) map.set(row.id, row);
      });
    }
    return {
      get(key) {
        return Promise.resolve(map.has(key) ? map.get(key) : undefined);
      },
      getAll() {
        return Promise.resolve(Array.from(map.values()));
      },
      set(key, value) {
        map.set(key, value);
        return Promise.resolve();
      },
      delete(key) {
        map.delete(key);
        return Promise.resolve();
      },
    };
  }

  function openDatabase(indexedDB) {
    return new Promise(function (resolve, reject) {
      let request;
      let settled = false;
      const fail = function (error) {
        if (settled) return;
        settled = true;
        reject(error || new Error('IndexedDB open failed'));
      };
      try {
        request = indexedDB.open(DATABASE_NAME, 1);
      } catch (error) {
        fail(error);
        return;
      }
      request.onupgradeneeded = function () {
        const database = request.result;
        if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
          const store = database.createObjectStore(OBJECT_STORE_NAME, { keyPath: 'id' });
          store.createIndex('videoId', 'videoId', { unique: false });
          store.createIndex('expiresAt', 'expiresAt', { unique: false });
        }
      };
      request.onsuccess = function () {
        if (settled) {
          try { request.result.close(); } catch (_) {}
          return;
        }
        settled = true;
        resolve(request.result);
      };
      request.onerror = function () { fail(request.error); };
      request.onblocked = function () { fail(new Error('IndexedDB open blocked')); };
    });
  }

  function createIndexedDbStore(indexedDB) {
    if (!indexedDB || typeof indexedDB.open !== 'function') return null;

    async function run(mode, operation) {
      const database = await openDatabase(indexedDB);
      return new Promise(function (resolve, reject) {
        let result;
        let settled = false;
        const fail = function (error) {
          if (settled) return;
          settled = true;
          try { database.close(); } catch (_) {}
          reject(error || new Error('IndexedDB transaction failed'));
        };
        try {
          const transaction = database.transaction(OBJECT_STORE_NAME, mode);
          const request = operation(transaction.objectStore(OBJECT_STORE_NAME));
          if (request && typeof request === 'object' && 'onsuccess' in request) {
            request.onsuccess = function () { result = request.result; };
            request.onerror = function () { fail(request.error); };
          } else {
            result = request;
          }
          transaction.oncomplete = function () {
            if (settled) return;
            settled = true;
            try { database.close(); } catch (_) {}
            resolve(result);
          };
          transaction.onerror = function () { fail(transaction.error); };
          transaction.onabort = function () { fail(transaction.error); };
        } catch (error) {
          fail(error);
        }
      });
    }

    return {
      get(key) {
        return run('readonly', function (store) { return store.get(key); });
      },
      getAll() {
        return run('readonly', function (store) { return store.getAll(); });
      },
      set(key, value) {
        return run('readwrite', function (store) { return store.put(value); });
      },
      delete(key) {
        return run('readwrite', function (store) { return store.delete(key); });
      },
    };
  }

  function createShadowRecordingCache(environment, options) {
    const settings = options || {};
    const env = environment || {};
    const ttlMs = Number.isFinite(Number(settings.ttlMs))
      ? Math.max(1, Number(settings.ttlMs))
      : DEFAULT_TTL_MS;
    const store = Object.prototype.hasOwnProperty.call(settings, 'store')
      ? settings.store
      : createIndexedDbStore(env.indexedDB);

    async function purgeExpired(at) {
      if (!store || typeof store.getAll !== 'function') return 0;
      const stamp = Number.isFinite(Number(at)) ? Number(at) : nowMs(env);
      const rows = await store.getAll();
      const list = Array.isArray(rows) ? rows : [];
      let removed = 0;
      for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!row || isFresh(row, stamp)) continue;
        if (typeof store.delete === 'function' && row.id) {
          await store.delete(row.id);
          removed += 1;
        }
      }
      return removed;
    }

    async function save(input) {
      if (!store || typeof store.set !== 'function') return null;
      const record = normalizeRecord(input, env, ttlMs);
      if (!record) return null;
      await purgeExpired();
      await store.set(record.id, record);
      return record;
    }

    async function get(input) {
      if (!store || typeof store.get !== 'function') return null;
      const videoId = input && input.videoId != null ? String(input.videoId).trim() : '';
      const segmentIndex = Number(input && input.segmentIndex);
      if (!videoId || !Number.isFinite(segmentIndex)) return null;
      const row = await store.get(makeId(videoId, segmentIndex));
      const stamp = nowMs(env);
      if (!isFresh(row, stamp)) {
        if (row && row.id && typeof store.delete === 'function') {
          try { await store.delete(row.id); } catch (_) {}
        }
        return null;
      }
      return row;
    }

    async function listForVideo(videoId) {
      if (!store || typeof store.getAll !== 'function') return [];
      const id = videoId != null ? String(videoId).trim() : '';
      if (!id) return [];
      const stamp = nowMs(env);
      const rows = await store.getAll();
      const list = Array.isArray(rows) ? rows : [];
      return list
        .filter((row) => row && String(row.videoId) === id && isFresh(row, stamp))
        .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    }

    async function getLatestForVideo(videoId) {
      const list = await listForVideo(videoId);
      return list[0] || null;
    }

    function applyToState(state, record, helpers) {
      if (!state || !record || !record.blob) return false;
      const createObjectURL = (helpers && helpers.createObjectURL)
        || (env.URL && typeof env.URL.createObjectURL === 'function' && env.URL.createObjectURL.bind(env.URL))
        || (typeof URL !== 'undefined' && URL.createObjectURL);
      const revokeObjectURL = (helpers && helpers.revokeObjectURL)
        || (env.URL && typeof env.URL.revokeObjectURL === 'function' && env.URL.revokeObjectURL.bind(env.URL))
        || (typeof URL !== 'undefined' && URL.revokeObjectURL);
      if (state.lastRecordingUrl && typeof revokeObjectURL === 'function') {
        try { revokeObjectURL(state.lastRecordingUrl); } catch (_) {}
      }
      state.lastRecordingBlob = record.blob;
      state.lastRecordingSegmentIndex = Number(record.segmentIndex);
      state.lastRecordingUrl = typeof createObjectURL === 'function'
        ? createObjectURL(record.blob)
        : '';
      return true;
    }

    return {
      ttlMs,
      save,
      get,
      listForVideo,
      getLatestForVideo,
      purgeExpired,
      applyToState,
      makeId,
      _store: store,
    };
  }

  return {
    DEFAULT_TTL_MS,
    createMemoryStore,
    createShadowRecordingCache,
    normalizeRecord,
    isFresh,
    makeId,
  };
});

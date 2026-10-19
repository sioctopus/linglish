/**
 * VideoMetadataEditor - 视频标签、难度与合集保存编排。
 *
 * 保持无 DOM 依赖，浏览器通过 window.VideoMetadataEditor 使用，
 * Node 测试通过 module.exports 直接加载。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VideoMetadataEditor = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ALLOWED_DIFFICULTIES = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'beginner', 'intermediate', 'advanced'];

  function normalizeMetadataUpdates(input) {
    var source = input || {};
    var difficulty = String(source.difficulty || '').trim().toLowerCase();
    var collectionName = String(source.collectionName || '').trim();
    return {
      difficulty_level: ALLOWED_DIFFICULTIES.indexOf(difficulty) !== -1 ? difficulty : null,
      collection_name: collectionName ? collectionName.slice(0, 120) : null
    };
  }

  async function saveVideoMetadata(options) {
    var opts = options || {};
    if (typeof opts.fetchImpl !== 'function') {
      throw new Error('缺少网络请求实现');
    }
    if (opts.videoId === null || opts.videoId === undefined || opts.videoId === '') {
      throw new Error('缺少视频 ID');
    }

    var base = opts.apiBase || '';
    var requestHeaders = opts.headers || {};
    var tagResponse = await opts.fetchImpl(`${base}/videos/${opts.videoId}/tags`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        global_tag_ids: Array.isArray(opts.globalTagIds) ? opts.globalTagIds : [],
        user_tag_ids: Array.isArray(opts.personalTagIds) ? opts.personalTagIds : []
      })
    });
    if (!tagResponse || !tagResponse.ok) {
      throw new Error(`标签保存失败${tagResponse && tagResponse.status ? ` (${tagResponse.status})` : ''}`);
    }

    var metadataResponse = await opts.fetchImpl(`${base}/video-resources/${opts.videoId}`, {
      method: 'PATCH',
      headers: requestHeaders,
      body: JSON.stringify(normalizeMetadataUpdates({
        difficulty: opts.difficulty,
        collectionName: opts.collectionName
      }))
    });
    if (!metadataResponse || !metadataResponse.ok) {
      throw new Error(`视频信息保存失败${metadataResponse && metadataResponse.status ? ` (${metadataResponse.status})` : ''}`);
    }

    var result = typeof metadataResponse.json === 'function'
      ? await metadataResponse.json()
      : {};
    return result && typeof result === 'object' ? result : {};
  }

  return {
    normalizeMetadataUpdates: normalizeMetadataUpdates,
    saveVideoMetadata: saveVideoMetadata
  };
});


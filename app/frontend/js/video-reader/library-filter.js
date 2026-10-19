/**
 * LibraryFilter - 视频库统一筛选模块（纯函数，无 DOM 依赖）
 *
 * 筛选状态（全部 AND 组合）：
 *   query       搜索词（匹配标题、文件名、合集名、标签名）
 *   difficulty  a1 | a2 | b1 | b2 | c1 | c2 | ''
 *               beginner/intermediate/advanced are accepted and mapped to a1/b1/c1
 *   scene       场景 key（work/daily/interview/travel）| ''
 *   status      unseen | in-progress | complete | ''
 *   tagId       标签 ID（字符串比较）| '_untagged' | ''
 *   scope       all | mine
 *
 * 外部数据通过 context 注入，保持模块可在 Node 中直接测试：
 *   currentUserId        当前用户 ID（scope=mine 用）
 *   getVideoTags(id)     -> 标签 ID 数组（任意类型，内部转字符串）
 *   getTagName(tagId)    -> 标签显示名（query 匹配标签名用，可选）
 *   getProgressPercent(id) -> 0-100（status 筛选用，可选）
 *   resolveSceneTagIds(sceneKey) -> 标签 ID 数组（scene 筛选用，可选）
 *   sceneKeywords        { [sceneKey]: string[] }（scene 关键词回退，可选）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LibraryFilter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CEFR_LEVELS = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];
  var LEGACY_LEVELS = { beginner: 'a1', intermediate: 'b1', advanced: 'c1' };

  function normalizeDifficultyLevel(raw) {
    var v = String(raw || '').trim().toLowerCase();
    if (LEGACY_LEVELS[v]) return LEGACY_LEVELS[v];
    return CEFR_LEVELS.indexOf(v) !== -1 ? v : null;
  }

  function createState(partial) {
    var p = partial || {};
    return {
      query: String(p.query || ''),
      difficulty: normalizeDifficultyLevel(p.difficulty) || '',
      scene: String(p.scene || ''),
      status: String(p.status || ''),
      tagId: p.tagId === null || p.tagId === undefined ? '' : String(p.tagId),
      scope: p.scope === 'mine' ? 'mine' : 'all'
    };
  }

  function hasActiveFilters(state) {
    var s = createState(state);
    return !!(s.query.trim() || s.difficulty || s.scene || s.status || s.tagId || s.scope === 'mine');
  }

  function matchesQuery(video, q, ctx) {
    if (!q) return true;
    var hay = [
      video.title,
      video.original_filename,
      video.collection_name,
      video.collection,
      video.series
    ].filter(Boolean).join(' ').toLowerCase();
    if (hay.indexOf(q) !== -1) return true;
    // 标签名匹配
    if (ctx && typeof ctx.getVideoTags === 'function' && typeof ctx.getTagName === 'function') {
      var ids = ctx.getVideoTags(video.id) || [];
      for (var i = 0; i < ids.length; i++) {
        var name = String(ctx.getTagName(ids[i]) || '').toLowerCase();
        if (name && name.indexOf(q) !== -1) return true;
      }
    }
    return false;
  }

  function matchesDifficulty(video, difficulty) {
    if (!difficulty) return true;
    return normalizeDifficultyLevel(video.difficulty_level) === difficulty;
  }

  function matchesScene(video, sceneKey, ctx) {
    if (!sceneKey) return true;
    // 1) 标签匹配
    if (ctx && typeof ctx.resolveSceneTagIds === 'function' && typeof ctx.getVideoTags === 'function') {
      var sceneTagIds = (ctx.resolveSceneTagIds(sceneKey) || []).map(String);
      if (sceneTagIds.length) {
        var videoTags = (ctx.getVideoTags(video.id) || []).map(String);
        for (var i = 0; i < sceneTagIds.length; i++) {
          if (videoTags.indexOf(sceneTagIds[i]) !== -1) return true;
        }
      }
    }
    // 2) 关键词回退
    var keywords = (ctx && ctx.sceneKeywords && ctx.sceneKeywords[sceneKey]) || [];
    if (!keywords.length) return false;
    var hay = [
      video.title,
      video.original_filename,
      video.collection_name,
      video.collection,
      video.series
    ].filter(Boolean).join(' ').toLowerCase();
    for (var k = 0; k < keywords.length; k++) {
      if (hay.indexOf(String(keywords[k]).toLowerCase()) !== -1) return true;
    }
    return false;
  }

  function matchesStatus(video, status, ctx) {
    if (!status) return true;
    var p = 0;
    if (ctx && typeof ctx.getProgressPercent === 'function') {
      p = Number(ctx.getProgressPercent(video.id)) || 0;
    }
    if (status === 'unseen') return p === 0;
    if (status === 'in-progress') return p > 0 && p < 90;
    if (status === 'complete') return p >= 90;
    return true;
  }

  function matchesTag(video, tagId, ctx) {
    if (!tagId) return true;
    var videoTags = [];
    if (ctx && typeof ctx.getVideoTags === 'function') {
      videoTags = (ctx.getVideoTags(video.id) || []).map(String);
    }
    if (tagId === '_untagged') return videoTags.length === 0;
    return videoTags.indexOf(String(tagId)) !== -1;
  }

  function matchesScope(video, scope, ctx) {
    if (scope !== 'mine') return true;
    var uid = ctx && ctx.currentUserId;
    if (uid === null || uid === undefined || uid === '') return false;
    if (video.uploader_id === null || video.uploader_id === undefined) return false;
    return String(video.uploader_id) === String(uid);
  }

  function filterVideos(videos, state, context) {
    var list = Array.isArray(videos) ? videos : [];
    var s = createState(state);
    var ctx = context || {};
    var q = s.query.trim().toLowerCase();
    return list.filter(function (v) {
      if (!v) return false;
      return matchesScope(v, s.scope, ctx)
        && matchesDifficulty(v, s.difficulty)
        && matchesScene(v, s.scene, ctx)
        && matchesStatus(v, s.status, ctx)
        && matchesTag(v, s.tagId, ctx)
        && matchesQuery(v, q, ctx);
    });
  }

  return {
    createState: createState,
    filterVideos: filterVideos,
    hasActiveFilters: hasActiveFilters,
    normalizeDifficultyLevel: normalizeDifficultyLevel
  };
});

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishCoachingMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ACTIONS = Object.freeze([
    { id: 'copy', label: '复制' },
    { id: 'note', label: '做笔记' },
    { id: 'highlight', label: '划线' },
    { id: 'lookup', label: 'AI查词' },
    { id: 'explain', label: '讲解' },
    { id: 'translate', label: '翻译' },
    { id: 'read', label: '逐句朗读' },
    { id: 'shadow', label: '跟读' },
  ]);

  const ACTIVE = new Set(['active', 'on_trial', 'trialing']);
  const GRACE = new Set(['cancelled', 'cancel_at_period_end', 'past_due']);
  const BLOCKED = new Set(['expired', 'paused', 'unpaid']);
  const ALIASES = { pro: 'vip', premium: 'vip' };
  const COACHING_TIERS = new Set(['vip', 'svip', 'family', 'admin']);
  const LINE_MARK = '__line__';

  function canUseCoaching(user, now) {
    if (!user || typeof user !== 'object') return false;
    if (user.is_admin === true) return true;
    const clock = now instanceof Date ? now : new Date();
    let tier = String(user.membership_type || 'free').trim().toLowerCase();
    tier = ALIASES[tier] || tier;
    if (!COACHING_TIERS.has(tier)) return false;
    let status = String(user.subscription_status || 'none').trim().toLowerCase();
    if (status === 'canceled') status = 'cancelled';
    const rawExpiry = user.membership_expires_at || user.subscription_end_date || null;
    const expiry = rawExpiry ? new Date(rawExpiry) : null;
    const expiryValid = Boolean(expiry && !Number.isNaN(expiry.getTime()));
    const expiryOk = !expiryValid || expiry > clock;
    if (BLOCKED.has(status)) return false;
    if (ACTIVE.has(status)) return expiryOk;
    if (GRACE.has(status)) return expiryValid && expiry > clock;
    return expiryOk;
  }

  function textOf(segment) {
    return String(segment && (segment.text ?? segment.transcript ?? segment.line) || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function translationOf(segment) {
    return String(segment && (segment.translation ?? segment.cn ?? segment.zh ?? segment.text_cn) || '').trim();
  }

  function boundsOf(segment) {
    const start = Number(segment && (segment.start_sec ?? segment.start ?? segment.startTime));
    const end = Number(segment && (segment.end_sec ?? segment.end ?? segment.endTime));
    const safeStart = Number.isFinite(start) ? start : 0;
    const safeEnd = Number.isFinite(end) && end > safeStart ? end : safeStart + 1.2;
    return { start: safeStart, end: safeEnd };
  }

  function indexAtTime(segments, time) {
    const moment = Number(time);
    if (!Number.isFinite(moment) || !Array.isArray(segments)) return -1;
    for (let i = 0; i < segments.length; i += 1) {
      const bounds = boundsOf(segments[i]);
      if (moment >= bounds.start && moment < bounds.end) return i;
    }
    return -1;
  }

  function rollingRows(segments, index) {
    const list = Array.isArray(segments) ? segments : [];
    const current = Number.isInteger(index) ? index : -1;
    return ['previous', 'current', 'next'].map((role, offset) => {
      const rowIndex = current + offset - 1;
      const segment = rowIndex >= 0 && rowIndex < list.length ? list[rowIndex] : null;
      const bounds = segment ? boundsOf(segment) : { start: 0, end: 0 };
      return {
        role,
        index: segment ? rowIndex : -1,
        text: segment ? textOf(segment) : '',
        translation: segment ? translationOf(segment) : '',
        start: bounds.start,
        end: bounds.end,
      };
    });
  }

  function tokenize(text) {
    const parts = String(text || '').match(/[A-Za-z]+(?:['’][A-Za-z]+)?|[^A-Za-z]+/g) || [];
    return parts.map((part) => ({
      text: part,
      word: /^[A-Za-z]/.test(part) ? part.replace(/’/g, "'") : '',
    }));
  }

  function emptyRecord() {
    return { notes: {}, marks: {} };
  }

  function recordKey(userId, videoId) {
    return `linglish.coaching.v1:${userId || 'local'}:${videoId || 'none'}`;
  }

  function readRecord(storage, userId, videoId) {
    if (!storage || typeof storage.getItem !== 'function') return emptyRecord();
    try {
      const parsed = JSON.parse(storage.getItem(recordKey(userId, videoId)) || 'null');
      return {
        notes: parsed && parsed.notes && typeof parsed.notes === 'object' ? parsed.notes : {},
        marks: parsed && parsed.marks && typeof parsed.marks === 'object' ? parsed.marks : {},
      };
    } catch (_) {
      return emptyRecord();
    }
  }

  function writeRecord(storage, userId, videoId, record) {
    const next = {
      notes: record && record.notes ? record.notes : {},
      marks: record && record.marks ? record.marks : {},
    };
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(recordKey(userId, videoId), JSON.stringify(next));
    }
    return next;
  }

  function toggleMark(record, index, token) {
    const source = record || emptyRecord();
    const key = String(index);
    const marks = Object.assign({}, source.marks);
    const current = Array.isArray(marks[key]) ? marks[key].slice() : [];
    const needle = String(token || '').trim().toLowerCase();
    const pos = current.findIndex((item) => String(item).toLowerCase() === needle);
    if (!needle) return { notes: Object.assign({}, source.notes), marks };
    if (pos >= 0) current.splice(pos, 1);
    else current.push(needle);
    if (current.length) marks[key] = current;
    else delete marks[key];
    return { notes: Object.assign({}, source.notes), marks };
  }

  function saveNote(record, index, text) {
    const source = record || emptyRecord();
    const notes = Object.assign({}, source.notes);
    const key = String(index);
    const value = String(text || '').trim().slice(0, 1000);
    if (value) notes[key] = value;
    else delete notes[key];
    return { notes, marks: Object.assign({}, source.marks) };
  }

  function noteFor(record, index) {
    const notes = record && record.notes;
    return notes ? String(notes[String(index)] || '') : '';
  }

  function isMarked(record, index, token) {
    const marks = record && record.marks && record.marks[String(index)];
    if (!Array.isArray(marks)) return false;
    const needle = String(token || '').toLowerCase();
    return marks.some((item) => String(item).toLowerCase() === needle);
  }

  function copyText(row, selectedText) {
    const selected = String(selectedText || '').trim();
    if (selected) return selected;
    const text = String(row && row.text || '').trim();
    const translation = String(row && row.translation || '').trim();
    return translation ? `${text}\n${translation}` : text;
  }

  return {
    ACTIONS,
    LINE_MARK,
    boundsOf,
    canUseCoaching,
    copyText,
    emptyRecord,
    indexAtTime,
    isMarked,
    noteFor,
    readRecord,
    recordKey,
    rollingRows,
    saveNote,
    textOf,
    toggleMark,
    tokenize,
    translationOf,
    writeRecord,
  };
});

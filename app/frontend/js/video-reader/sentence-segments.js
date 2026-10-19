(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishSentenceSegments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const END_PUNCTUATION = /[.!?。！？][”’"')\]]*$/;
  const MAX_GAP_SECONDS = 1.4;
  const INCOMPLETE_GAP_SECONDS = 2.8;
  const SAFETY_MAX_WORDS = 80;
  const SAFETY_MAX_DURATION_SECONDS = 24;
  const PARAGRAPH_MAX_SENTENCES = 3;
  const PARAGRAPH_MAX_WORDS = 55;
  const PARAGRAPH_MAX_GAP_SECONDS = 1.5;

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function startOf(segment) {
    return numberOrNull(segment && (segment.start_sec ?? segment.start ?? segment.startTime));
  }

  function endOf(segment) {
    return numberOrNull(segment && (segment.end_sec ?? segment.end ?? segment.endTime));
  }

  function textOf(segment) {
    return String(segment && (segment.text ?? segment.transcript ?? segment.line) || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function translationOf(segment) {
    return String(segment && (segment.translation ?? segment.cn ?? segment.zh ?? segment.text_cn) || '').trim();
  }

  function countWords(text) {
    return (String(text || '').match(/\b[\w’'-]+\b/g) || []).length;
  }

  function maskInternalPeriods(text) {
    return String(text || '')
      .replace(/\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sr|Jr|St|vs|etc)\./gi, (match) => `${match.slice(0, -1)}∯`)
      .replace(/\b(?:e\.g|i\.e|a\.m|p\.m|U\.S|U\.K)\./gi, (match) => match.replace(/\./g, '∯'))
      .replace(/(\d)\.(?=\d)/g, '$1∯');
  }

  function unmaskPeriods(text) {
    return String(text || '').replace(/∯/g, '.');
  }

  function splitSentences(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    const masked = maskInternalPeriods(normalized);
    const parts = masked.match(/[^.!?。！？]+[.!?。！？]+[”’"')\]]*|[^.!?。！？]+$/g);
    return (parts || [masked]).map((part) => unmaskPeriods(part).trim()).filter(Boolean);
  }

  function endsSentence(text) {
    return END_PUNCTUATION.test(String(text || '').trim());
  }

  function splitSegment(segment, sourceIndex) {
    const text = textOf(segment);
    if (!text) return [];
    const textParts = splitSentences(text);
    const translation = translationOf(segment);
    const translationParts = translation ? splitSentences(translation) : [];
    const start = startOf(segment) ?? 0;
    const rawEnd = endOf(segment);
    const end = rawEnd != null && rawEnd > start ? rawEnd : start + Math.max(0.6, text.length / 14);
    const totalWeight = textParts.reduce((sum, part) => sum + Math.max(1, part.length), 0);
    let cursor = start;

    return textParts.map((part, index) => {
      const isLast = index === textParts.length - 1;
      const share = Math.max(1, part.length) / totalWeight;
      const partEnd = isLast ? end : Math.min(end, cursor + (end - start) * share);
      const piece = {
        ...segment,
        text: part,
        start: cursor,
        end: partEnd,
        start_sec: cursor,
        end_sec: partEnd,
        source_indices: Array.isArray(segment.source_indices)
          ? segment.source_indices.slice()
          : [sourceIndex],
      };
      if (translationParts.length === textParts.length) {
        piece.translation = translationParts[index] || '';
      } else if (translation) {
        // Preserve the source translation once; later merging deduplicates it.
        piece.translation = index === 0 ? translation : '';
      }
      cursor = partEnd;
      return piece;
    });
  }

  function joinText(left, right) {
    return `${String(left || '').trim()} ${String(right || '').trim()}`.replace(/\s+/g, ' ').trim();
  }

  function joinTranslation(left, right) {
    const a = String(left || '').trim();
    const b = String(right || '').trim();
    if (!a) return b;
    if (!b || a === b || a.endsWith(b)) return a;
    if (b.startsWith(a)) return b;
    const cjkBoundary = /[\u3400-\u9fff]$/.test(a) || /^[\u3400-\u9fff]/.test(b);
    return cjkBoundary ? `${a}${b}` : `${a} ${b}`;
  }

  function makeOutput(piece) {
    const start = startOf(piece) ?? 0;
    const end = endOf(piece) ?? start + 0.6;
    return {
      ...piece,
      text: textOf(piece),
      start,
      end,
      start_sec: start,
      end_sec: end,
      source_indices: Array.from(new Set(piece.source_indices || [])),
    };
  }

  function canJoin(buffer, piece) {
    if (!buffer) return false;
    const bufferSpeaker = String(buffer.speaker || '').trim();
    const pieceSpeaker = String(piece.speaker || '').trim();
    if (bufferSpeaker && pieceSpeaker && bufferSpeaker !== pieceSpeaker) return false;

    const incomplete = !endsSentence(buffer.text);
    const gap = Math.max(0, (startOf(piece) ?? 0) - (endOf(buffer) ?? 0));
    if (gap > (incomplete ? INCOMPLETE_GAP_SECONDS : MAX_GAP_SECONDS)) return false;
    if (!incomplete) return false;

    const combinedText = joinText(buffer.text, piece.text);
    const duration = (endOf(piece) ?? 0) - (startOf(buffer) ?? 0);
    return countWords(combinedText) <= SAFETY_MAX_WORDS && duration <= SAFETY_MAX_DURATION_SECONDS;
  }

  function mergePieces(pieces) {
    const output = [];
    let buffer = null;

    function flush() {
      if (!buffer) return;
      output.push(makeOutput(buffer));
      buffer = null;
    }

    pieces.forEach((piece) => {
      if (!buffer) {
        buffer = makeOutput(piece);
      } else if (canJoin(buffer, piece)) {
        buffer.text = joinText(buffer.text, piece.text);
        buffer.translation = joinTranslation(buffer.translation, piece.translation);
        buffer.end = endOf(piece) ?? buffer.end;
        buffer.end_sec = buffer.end;
        buffer.source_indices = Array.from(new Set([
          ...(buffer.source_indices || []),
          ...(piece.source_indices || []),
        ]));
      } else {
        flush();
        buffer = makeOutput(piece);
      }

      if (buffer && END_PUNCTUATION.test(buffer.text)) flush();
    });

    flush();
    return output;
  }

  function toCompleteSentences(segments) {
    if (!Array.isArray(segments) || !segments.length) return [];
    const pieces = [];
    segments.forEach((segment, index) => {
      pieces.push(...splitSegment(segment || {}, index));
    });
    return mergePieces(pieces);
  }

  function toDisplayedSentences(segments) {
    const raw = Array.isArray(segments) ? segments : [];
    const sourceBound = raw.map((segment, index) => ({
      ...(segment || {}),
      source_indices: [index],
    }));
    return toCompleteSentences(sourceBound).map((segment, index) => ({
      ...segment,
      index,
    }));
  }

  function sameSpeaker(left, right) {
    const a = String(left && left.speaker || '').trim();
    const b = String(right && right.speaker || '').trim();
    return !a || !b || a === b;
  }

  function canGroupParagraph(buffer, piece) {
    if (!buffer || !sameSpeaker(buffer, piece)) return false;
    const gap = Math.max(0, (startOf(piece) ?? 0) - (endOf(buffer) ?? 0));
    if (!endsSentence(buffer.text)) return gap <= INCOMPLETE_GAP_SECONDS;
    if (gap > PARAGRAPH_MAX_GAP_SECONDS) return false;
    const sentenceCount = buffer.sentence_count || 1;
    const combinedWords = countWords(joinText(buffer.text, piece.text));
    return sentenceCount < PARAGRAPH_MAX_SENTENCES && combinedWords <= PARAGRAPH_MAX_WORDS;
  }

  function toParagraphs(sentences) {
    const output = [];
    let buffer = null;

    function flush() {
      if (!buffer) return;
      const paragraph = makeOutput(buffer);
      delete paragraph.sentence_count;
      output.push(paragraph);
      buffer = null;
    }

    (Array.isArray(sentences) ? sentences : []).forEach((piece) => {
      const text = textOf(piece);
      if (!text) return;
      if (!buffer) {
        buffer = makeOutput(piece);
        buffer.sentence_count = endsSentence(text) ? 1 : 0;
        return;
      }
      if (canGroupParagraph(buffer, piece)) {
        buffer.text = joinText(buffer.text, text);
        buffer.translation = joinTranslation(buffer.translation, translationOf(piece));
        buffer.end = endOf(piece) ?? buffer.end;
        buffer.end_sec = buffer.end;
        buffer.sentence_count = (buffer.sentence_count || 0) + (endsSentence(text) ? 1 : 0);
        buffer.source_indices = Array.from(new Set([
          ...(buffer.source_indices || []),
          ...(piece.source_indices || []),
        ]));
        return;
      }
      flush();
      buffer = makeOutput(piece);
      buffer.sentence_count = endsSentence(text) ? 1 : 0;
    });

    flush();
    return output;
  }

  function toDisplayedParagraphs(segments) {
    return toParagraphs(toDisplayedSentences(segments)).map((segment, index) => ({
      ...segment,
      index,
    }));
  }

  return {
    splitSentences,
    toCompleteSentences,
    toDisplayedSentences,
    toDisplayedParagraphs,
  };
});

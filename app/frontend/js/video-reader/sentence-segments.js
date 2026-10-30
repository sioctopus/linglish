(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishSentenceSegments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const END_PUNCTUATION = /[.!?。！？][”’"')\]]*$/;
  const MAX_GAP_SECONDS = 1.2;
  const INCOMPLETE_GAP_SECONDS = 2.0;
  // Keep display close to timed video cues — one short sentence/line, not a paragraph.
  const SAFETY_MAX_WORDS = 22;
  const SAFETY_MAX_DURATION_SECONDS = 7;
  // Incomplete YouTube cue tails ("how about" + "you") must still glue even when
  // the two timed windows together are longer than a single practice line.
  const INCOMPLETE_MAX_DURATION_SECONDS = 14;
  const INCOMPLETE_MAX_WORDS = 28;
  const SOFT_SPLIT_MIN_WORDS = 12;
  // Hard cap for one on-screen practice / focus card (desktop + mobile).
  const PRACTICE_MAX_WORDS = 12;
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
    const hard = (parts || [masked]).map((part) => unmaskPeriods(part).trim()).filter(Boolean);
    // YouTube auto-captions often omit ".!?". Soft-split long clauses at ", and/but/…"
    // so two spoken lines are not shown as one truncated practice row.
    const soft = [];
    hard.forEach((part) => soft.push(...splitSoftClauses(part)));
    return soft.length ? soft : hard;
  }

  function bestCommaBreak(text, maxWords) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    const words = countWords(normalized);
    if (!normalized || words <= maxWords) return null;
    // Prefer discourse commas (…, and/so/but…) then any list comma with balanced sides.
    const patterns = [
      /,\s+(?=(?:and|but|or|so|because|which|who|that|then)\b)/gi,
      /,\s+/g,
    ];
    let best = null;
    patterns.forEach((pattern) => {
      pattern.lastIndex = 0;
      let match = pattern.exec(normalized);
      while (match) {
        if (match.index != null && match.index >= 12) {
          const left = normalized.slice(0, match.index).trim();
          const right = normalized.slice(match.index + match[0].length).trim();
          const leftWords = countWords(left);
          const rightWords = countWords(right);
          if (leftWords >= 4 && rightWords >= 3) {
            const overflow = Math.max(0, leftWords - maxWords) + Math.max(0, rightWords - maxWords);
            const balance = Math.abs(leftWords - rightWords);
            const score = overflow * 100 + balance;
            if (!best || score < best.score) best = { left, right, score };
          }
        }
        match = pattern.exec(normalized);
      }
      if (best && best.score < 100) return;
    });
    return best;
  }

  function forceBreakLongClause(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    const out = [];
    let rest = normalized;
    while (countWords(rest) > PRACTICE_MAX_WORDS) {
      const cut = bestCommaBreak(rest, PRACTICE_MAX_WORDS)
        || bestCommaBreak(rest, Math.max(6, Math.ceil(countWords(rest) / 2)));
      if (cut) {
        out.push(cut.left.replace(/[,，]\s*$/, '').trim());
        rest = cut.right;
        continue;
      }
      // Last resort: break near the word budget on a space.
      const tokens = rest.split(/\s+/);
      const left = tokens.slice(0, PRACTICE_MAX_WORDS).join(' ').trim();
      const right = tokens.slice(PRACTICE_MAX_WORDS).join(' ').trim();
      if (!left || !right) break;
      out.push(left);
      rest = right;
    }
    if (rest) out.push(rest);
    return out.length ? out : [normalized];
  }

  function splitSoftClauses(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    const dialogueParts = splitDialogueTurns(normalized);
    const pieces = [];
    dialogueParts.forEach((part) => {
      if (countWords(part) < SOFT_SPLIT_MIN_WORDS) {
        pieces.push(part);
        return;
      }
      // Even with a final ".!?", long lines that pack two spoken clauses
      // (e.g. "…expressions, and you'll…") should become two practice rows.
      let rest = part;
      while (countWords(rest) >= SOFT_SPLIT_MIN_WORDS) {
        const match = rest.match(/,\s+(?=(?:and|but|or|so|because|which|who|that|then)\b)/i);
        if (!match || match.index == null || match.index < 18) break;
        const left = rest.slice(0, match.index).trim();
        const right = rest.slice(match.index + match[0].length).trim();
        if (countWords(left) < 5 || countWords(right) < 4) break;
        pieces.push(...forceBreakLongClause(left.replace(/[,，]\s*$/, '').trim()));
        rest = right;
      }
      if (rest) pieces.push(...forceBreakLongClause(rest));
    });
    return pieces.length ? pieces : [normalized];
  }

  // Keep reciprocal cards like "I'm good how about you" / "that's good what about you".
  function isShortReplyAboutYouCard(left, right) {
    const leftOk = /^(?:(?:i(?:['’]m| am)|that(?:['’]s| is))\s+)?(?:good|fine|ok|okay|great|well|alright)\b/i.test(String(left || '').trim());
    const rightOk = /^(?:how|what)\s+about\s+you\b/i.test(String(right || '').trim());
    return leftOk && rightOk;
  }

  function looksLikeFinishedClause(left) {
    const text = String(left || '').trim();
    if (!text) return false;
    if (endsSentence(text)) return true;
    if (/\bhow about you\b[.!?…]?$/i.test(text)) return true;
    if (/\bwhat about you\b[.!?…]?$/i.test(text)) return true;
    if (/\bnice to meet you(?:\s+too)?\b[.!?…]?$/i.test(text)) return true;
    if (/\bwhere are you from\b[.!?…]?$/i.test(text)) return true;
    return /\b(?:you|too|thanks|thank you|please|okay|ok|yeah|yes|yep|no|good|fine|great|name|yours|morning|afternoon|evening|here|there|important|exercise|fun|nice|job|work|gym|office|teacher|kids|children|friends|movies|sports|busy|tiring|difficult|canada|home|school|today|tonight)\b[.!?…]?$/i.test(text);
  }

  function looksLikeNewDialogueTurn(right) {
    return /^(?:oh\s+(?:that|it|i|you|we|nice)\b|yeah\b|yes\b|yep\b|that(?:['’]s| is| sounds)\b|it(?:['’]s)\b|i(?:['’]m| am)\b|i\s+(?:go|work|like|want|have|teach|live|need|think|know|see|feel|enjoy|play|read|watch|can|could)\b|(?:do|did|are|have|can|would|could)\s+you\b|(?:what|where|when|why|how)\s+do\b|(?:where|how)\s+are\s+you\b|what(?:['’]s| is)\b|(?:what|how)\s+about\b|my name is\b|nice to meet\b)/i.test(String(right || '').trim());
  }

  // YouTube auto-captions for dialogues often omit "?!" and pack turns into one cue.
  // Split before a NEW speaker turn — but keep "I'm good how about you" as one line
  // (matches on-screen cards like "I'm good! How about you?").
  function splitDialogueTurns(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized || countWords(normalized) < 6) return [normalized];
    const parts = [];
    let rest = normalized;
    const starter = /\s+(?=(?:oh\s+(?:that|it|i|you|we|nice)\b|yeah\b|yes\b|yep\b|that(?:['’]s| is| sounds)\b|it(?:['’]s)\b|i(?:['’]m| am)\b|i\s+(?:go|work|like|want|have|teach|live|need|think|know|see|feel|enjoy|play|read|watch|can|could)\b|(?:do|did|are|have|can|would|could)\s+you\b|(?:what|where|when|why|how)\s+do\b|(?:where|how)\s+are\s+you\b|what(?:['’]s| is)\b|(?:what|how)\s+about\b|my name is\b|nice to meet\b))/gi;
    while (countWords(rest) >= 5) {
      starter.lastIndex = 0;
      let found = null;
      let match = starter.exec(rest);
      while (match) {
        const left = rest.slice(0, match.index).trim();
        const right = rest.slice(match.index).trim();
        const leftWords = countWords(left);
        const rightWords = countWords(right);
        const starterToken = String(right.split(/\s+/)[0] || '').toLowerCase();
        if (isShortReplyAboutYouCard(left, right)) {
          match = starter.exec(rest);
          continue;
        }
        // Keep "what time do you" / "where do you" intact — "do you" is not a new turn here.
        if (/^do you\b/i.test(right) && /\b(?:what|where|when|why|how)(?:\s+\w+)?$/i.test(left)) {
          match = starter.exec(rest);
          continue;
        }
        // Keep "where/how/what are you" intact — "are you" is not a new turn here.
        if (/^are you\b/i.test(right) && /\b(?:where|how|what|who)\s*$/i.test(left)) {
          match = starter.exec(rest);
          continue;
        }
        // Keep "how long have you" intact — "have you" continues the question.
        if (/^have you\b/i.test(right) && /\b(?:how long|where|what)\s*$/i.test(left)) {
          match = starter.exec(rest);
          continue;
        }
        // Keep "oh that's great" as one reaction (don't cut after bare "oh").
        if (/^that(?:['’]s| is| sounds)\b/i.test(right) && /^(?:oh|yeah|yes|yep|wow)$/i.test(left)) {
          match = starter.exec(rest);
          continue;
        }
        const finished = looksLikeFinishedClause(left);
        const rightTurn = looksLikeNewDialogueTurn(right);
        const allowShortLeft = leftWords >= 1 && rightWords >= 3
          && /^(?:what(?:['’]s|s)?|my|nice)$/i.test(starterToken)
          && /^(?:thanks|thank you|please|okay|ok|yeah|yes|hi|hello|fine)$/i.test(left);
        // Noun/fragment + reaction ("co-workers that's important"), not interjection "oh".
        const fragmentThenReaction = leftWords >= 1 && rightWords >= 2
          && !endsWithIncompleteStructure(left)
          && !/^(?:oh|yeah|yes|yep|wow)$/i.test(left)
          && /^(?:that(?:['’]s| is| sounds)|oh\b)/i.test(right);
        if (rightTurn || allowShortLeft || fragmentThenReaction) {
          if (finished || leftWords >= 4 || allowShortLeft || fragmentThenReaction
            || (leftWords >= 3 && /^(?:that(?:['’]s| is| sounds)|oh\b|do you\b|what(?:['’]s)|(?:what|how)\s+about)\b/i.test(right))) {
            found = { left, right };
            break;
          }
        }
        match = starter.exec(rest);
      }
      if (!found) break;
      parts.push(found.left);
      rest = found.right;
    }
    if (rest) parts.push(rest);
    return parts.length ? parts : [normalized];
  }

  function endsSentence(text) {
    return END_PUNCTUATION.test(String(text || '').trim());
  }

  // Only glue fragments that are clearly cut mid-phrase (YouTube auto-captions).
  // Do not merge just because the line has no period — that turns several spoken
  // lines into one long paragraph under the player.
  function endsWithIncompleteStructure(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || endsSentence(trimmed)) return false;
    return [
      /\b(?:how|what)\s+about\s*$/i,
      // YouTube often cuts "nice to meet you" after meet.
      /\b(?:nice|pleased|glad|good)\s+to\s+(?:meet|see)\s*$/i,
      /\b(?:kind|sort|type)\s+of\s*$/i,
      /\b(?:a lot|lots|one|out|because)\s+of\s*$/i,
      /\b(a|an|the)\s*$/i,
      /\b(my|your|his|her|its|our|their|this|that|these|those)\s*$/i,
      /\b(of|to|for|with|in|on|at|by|from|about|into|through|during|before|after|above|below|between|under|over)\s*$/i,
      /\b(and|or|but|so|because|although|while|when|if|unless|until|as|since|that|which|who|whom|whose|where)\s*$/i,
      /\b(is|are|was|were|am|be|been|being|can|could|will|would|shall|should|may|might|must)\s*$/i,
      /\b(have|has|had|do|does|did|going|gonna)\s*$/i,
      /\b(all|some|any|lots|lot|kind|sort|type|one|each|every|more|most|none)\s*$/i,
      /['’]s?\s*$/,
      /\b\d+\s*$/,
    ].some((pattern) => pattern.test(trimmed));
  }

  // When two cues cannot fully merge, move the dangling ending onto the next cue
  // so "…how about" / "you…" does not leave a stranded tail on either side.
  function peelIncompleteTail(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || !endsWithIncompleteStructure(trimmed)) return null;
    const multi = trimmed.match(/\s+((?:how|what)\s+about|(?:nice|pleased|glad|good)\s+to\s+(?:meet|see)|(?:kind|sort|type)\s+of|(?:a lot|lots|one|out|because)\s+of)\s*$/i);
    if (multi && multi.index != null) {
      const head = trimmed.slice(0, multi.index).trim();
      const tail = multi[1].trim();
      if (head && tail && countWords(head) >= 2) return { head, tail };
    }
    const single = trimmed.match(/\s+(\S+)\s*$/);
    if (!single || single.index == null) return null;
    const head = trimmed.slice(0, single.index).trim();
    const tail = single[1].trim();
    if (!head || !tail || countWords(head) < 2) return null;
    if (endsWithIncompleteStructure(head) && countWords(trimmed) >= 4) {
      // Peel two trailing words when one is not enough (e.g. "how about").
      const two = trimmed.match(/\s+(\S+\s+\S+)\s*$/);
      if (two && two.index != null) {
        const head2 = trimmed.slice(0, two.index).trim();
        const tail2 = two[1].trim();
        if (head2 && countWords(head2) >= 2 && !endsWithIncompleteStructure(head2)) {
          return { head: head2, tail: tail2 };
        }
      }
    }
    if (endsWithIncompleteStructure(head)) return null;
    return { head, tail };
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

  // YouTube often parks the last word of a phrase on the next cue:
  // "nice to meet you" + "too where are you" / "where are you" + "from I'm…"
  // Only move the orphan token — never invent times outside the next cue window.
  function takeLeadingContinuation(prevText, nextText) {
    const prev = String(prevText || '').trim();
    const next = String(nextText || '').trim();
    if (!prev || !next || endsSentence(prev)) return null;
    const rules = [
      { prev: /\b(?:nice|glad|pleased|good)\s+to\s+meet\s+you$/i, take: /^(too)\b(?:\s+|$)/i },
      { prev: /\bwhere\s+are\s+you$/i, take: /^(from)\b(?:\s+|$)/i },
      { prev: /\b(?:where|what|how)\s+do\s+you$/i, take: /^(live|work|do|teach|go|study|play|like)\b(?:\s+|$)/i },
      { prev: /\bhow\s+are\s+you$/i, take: /^(doing)\b(?:\s+|$)/i },
      { prev: /\blast$/i, take: /^(year|night|week|month|time)\b(?:\s+|$)/i },
      { prev: /\blived$/i, take: /^(there|here)\b(?:\s+|$)/i },
      // "yes they" + "do do you like…" → "yes they do" / "do you like…"
      { prev: /\bthey$/i, take: /^(do)(?:\s+do)?\b(?:\s+|$)/i },
    ];
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      if (!rule.prev.test(prev)) continue;
      const match = next.match(rule.take);
      if (!match) continue;
      const token = match[1];
      const rest = next.slice(match[0].length).trim();
      return { attached: joinText(prev, token), rest };
    }
    return null;
  }

  function findIndexByTime(segments, t, tolerance) {
    const list = Array.isArray(segments) ? segments : [];
    if (!list.length || !Number.isFinite(t)) return -1;
    const tol = Number.isFinite(tolerance) ? tolerance : 0.1;
    const matching = [];
    for (let i = 0; i < list.length; i += 1) {
      const start = startOf(list[i]) ?? 0;
      const endRaw = endOf(list[i]);
      const end = Number.isFinite(endRaw) ? endRaw : start + 5;
      if (t >= start - tol && t < end + tol) {
        matching.push({
          index: i,
          distanceFromStart: Math.abs(t - start),
          distanceFromMid: Math.abs(t - (start + end) / 2),
        });
      }
    }
    if (matching.length) {
      matching.sort((a, b) => {
        const startDiff = a.distanceFromStart - b.distanceFromStart;
        if (Math.abs(startDiff) > 0.5) return startDiff;
        return a.distanceFromMid - b.distanceFromMid;
      });
      return matching[0].index;
    }
    let best = -1;
    let minDiff = Infinity;
    for (let i = 0; i < list.length; i += 1) {
      const start = startOf(list[i]) ?? 0;
      const diff = t - start;
      if (diff >= -tol && diff < minDiff && diff < 3) {
        minDiff = diff;
        best = i;
      }
    }
    return best;
  }

  // Playback clock: raw cue by time → display card that owns that source index.
  function displayIndexForTime(displaySegments, rawSegments, t, tolerance) {
    const display = Array.isArray(displaySegments) ? displaySegments : [];
    const raw = Array.isArray(rawSegments) ? rawSegments : [];
    const tol = Number.isFinite(tolerance) ? tolerance : 0.1;
    if (!display.length) return -1;
    const rawIdx = raw.length ? findIndexByTime(raw, t, tol) : -1;
    if (rawIdx < 0) return findIndexByTime(display, t, tol);

    const hits = [];
    display.forEach((seg, index) => {
      const idxs = Array.isArray(seg && seg.source_indices) ? seg.source_indices : [];
      if (idxs.some((value) => Number(value) === rawIdx)) hits.push(index);
    });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const containing = hits.filter((index) => {
        const start = startOf(display[index]) ?? 0;
        const endRaw = endOf(display[index]);
        const end = Number.isFinite(endRaw) ? endRaw : start + 5;
        return t >= start - tol && t < end + tol;
      });
      if (containing.length === 1) return containing[0];
      if (containing.length > 1) {
        containing.sort((a, b) => {
          const aStart = startOf(display[a]) ?? 0;
          const bStart = startOf(display[b]) ?? 0;
          return Math.abs(t - aStart) - Math.abs(t - bStart);
        });
        return containing[0];
      }
      hits.sort((a, b) => {
        const aStart = startOf(display[a]) ?? 0;
        const bStart = startOf(display[b]) ?? 0;
        return Math.abs(t - aStart) - Math.abs(t - bStart);
      });
      return hits[0];
    }
    return findIndexByTime(display, t, tol);
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

    if (endsSentence(buffer.text)) return false;

    const gap = Math.max(0, (startOf(piece) ?? 0) - (endOf(buffer) ?? 0));
    const nextText = textOf(piece);
    const incompleteTail = endsWithIncompleteStructure(buffer.text);
    // Tiny cue glue is for mid-phrase scraps ("the" / "floors"), not a new spoken turn
    // like "that's important" after "co-workers".
    // Tiny scraps only — never glue a new WH-question onto the previous line.
    const shortGlue = countWords(nextText) <= 3
      && !/^[A-Z\u3400-\u9fff]/.test(nextText)
      && !looksLikeNewDialogueTurn(nextText)
      && !/^(?:where|what|when|why|how|who)\b/i.test(nextText);

    // Prefer one timed line per display row. Only stitch obvious mid-phrase cuts
    // (e.g. "...walk up all" + "the floors"), never glue whole spoken lines into a paragraph.
    if (!incompleteTail && !(shortGlue && gap <= MAX_GAP_SECONDS)) {
      return false;
    }
    if (gap > (incompleteTail ? INCOMPLETE_GAP_SECONDS : MAX_GAP_SECONDS)) return false;
    if (/^[A-Z\u3400-\u9fff]/.test(nextText) && !incompleteTail) return false;
    if (looksLikeNewDialogueTurn(nextText) && !incompleteTail) return false;

    const combinedText = joinText(buffer.text, piece.text);
    const duration = (endOf(piece) ?? 0) - (startOf(buffer) ?? 0);
    const maxWords = incompleteTail ? INCOMPLETE_MAX_WORDS : SAFETY_MAX_WORDS;
    const maxDuration = incompleteTail ? INCOMPLETE_MAX_DURATION_SECONDS : SAFETY_MAX_DURATION_SECONDS;
    return countWords(combinedText) <= maxWords && duration <= maxDuration;
  }

  function mergePieces(pieces) {
    const output = [];
    let buffer = null;

    function flush() {
      if (!buffer) return;
      output.push(makeOutput(buffer));
      buffer = null;
    }

    pieces.forEach((rawPiece) => {
      let piece = rawPiece;
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
        const absorbed = takeLeadingContinuation(buffer.text, textOf(piece));
        if (absorbed) {
          const prevText = buffer.text;
          buffer.text = absorbed.attached;
          buffer.source_indices = Array.from(new Set([
            ...(buffer.source_indices || []),
            ...(piece.source_indices || []),
          ]));
          if (!absorbed.rest) {
            buffer.end = endOf(piece) ?? buffer.end;
            buffer.end_sec = buffer.end;
            buffer.translation = joinTranslation(buffer.translation, piece.translation);
          } else {
            const pieceStart = startOf(piece) ?? endOf(buffer) ?? 0;
            const pieceEnd = endOf(piece) ?? pieceStart;
            const tokenShare = Math.min(
              0.35,
              Math.max(0.1, (absorbed.attached.length - prevText.length) / Math.max(1, textOf(piece).length)),
            );
            const splitAt = pieceStart + Math.max(0.05, (pieceEnd - pieceStart) * tokenShare);
            buffer.end = Math.min(pieceEnd, splitAt);
            buffer.end_sec = buffer.end;
            flush();
            buffer = makeOutput({
              ...piece,
              text: absorbed.rest,
              start: splitAt,
              start_sec: splitAt,
              end: pieceEnd,
              end_sec: pieceEnd,
            });
          }
        } else {
          const peeled = peelIncompleteTail(buffer.text);
          if (peeled && peeled.head && peeled.tail) {
            buffer.text = peeled.head;
            flush();
            piece = {
              ...piece,
              text: joinText(peeled.tail, textOf(piece)),
            };
            buffer = makeOutput(piece);
          } else {
            flush();
            buffer = makeOutput(piece);
          }
        }
      }

      if (buffer && END_PUNCTUATION.test(buffer.text)) flush();
    });

    flush();
    return output;
  }

  function expandDialogueSplits(segments) {
    const output = [];
    (Array.isArray(segments) ? segments : []).forEach((segment) => {
      const text = textOf(segment);
      const parts = splitDialogueTurns(text);
      if (parts.length <= 1) {
        output.push(segment);
        return;
      }
      const translation = translationOf(segment);
      const start = startOf(segment) ?? 0;
      const end = endOf(segment) ?? start + Math.max(0.6, text.length / 14);
      const totalWeight = parts.reduce((sum, part) => sum + Math.max(1, part.length), 0);
      let cursor = start;
      parts.forEach((part, index) => {
        const isLast = index === parts.length - 1;
        const share = Math.max(1, part.length) / totalWeight;
        const partEnd = isLast ? end : Math.min(end, cursor + (end - start) * share);
        const piece = makeOutput({
          ...segment,
          text: part,
          start: cursor,
          end: partEnd,
          start_sec: cursor,
          end_sec: partEnd,
          translation: index === 0 ? translation : '',
        });
        output.push(piece);
        cursor = partEnd;
      });
    });
    return output;
  }

  function toCompleteSentences(segments) {
    if (!Array.isArray(segments) || !segments.length) return [];
    const pieces = [];
    segments.forEach((segment, index) => {
      pieces.push(...splitSegment(segment || {}, index));
    });
    // 1) Orphan-attach / incomplete glue across cues.
    // 2) Dialogue splits only inside each resulting card's own [start, end]
    //    (never invent times outside that window).
    return expandDialogueSplits(mergePieces(pieces));
  }

  function translationLikelyStale(english, chinese) {
    const en = String(english || '').trim();
    const zh = String(chinese || '').trim();
    if (!zh) return true;
    if (!en) return false;
    const enWords = countWords(en);
    const zhChars = (zh.match(/[\u4e00-\u9fa5]/g) || []).join('').length;
    // Discourse scrap / short split card still carrying the parent gloss.
    if (zhChars > 0 && /^(?:thanks|thank you|please|okay|ok|yeah|yes|yep|hi|hello|fine|oh|wow)$/i.test(en)) {
      return true;
    }
    if (enWords <= 2 && zhChars >= 2) return true;
    // Parent-cue leftovers after English re-split: longer EN + tiny ZH gloss.
    if (enWords >= 4 && zhChars <= 4) return true;
    if (enWords >= 6 && zhChars <= 6) return true;
    if (enWords >= 3 && zhChars > 0 && zhChars * 2 < enWords) return true;
    return false;
  }

  function toDisplayedSentences(segments) {
    const raw = Array.isArray(segments) ? segments : [];
    const sourceBound = raw.map((segment, index) => ({
      ...(segment || {}),
      source_indices: [index],
    }));
    return toCompleteSentences(sourceBound).map((segment, index) => {
      const text = textOf(segment);
      const translation = translationOf(segment);
      const next = {
        ...segment,
        text,
        index,
      };
      // Drop inherited/wrong Chinese after English boundary repair so bilingual can refetch.
      if (translationLikelyStale(text, translation)) {
        next.translation = '';
        next.cn = '';
        next.zh = '';
        next.text_cn = '';
      } else {
        next.translation = translation;
      }
      return next;
    });
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
    findIndexByTime,
    displayIndexForTime,
  };
});

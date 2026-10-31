/**
 * UI Manager Module
 * Handles DOM manipulation, UI rendering, and progress updates
 */

import { formatTime, escapeHtml, normalizeSegmentIndex, buildSegmentKey } from './utils.js';

/**
 * Update auto practice status
 * @param {HTMLElement} statusIcon - Status icon element
 * @param {HTMLElement} statusText - Status text element
 * @param {string} icon - Icon text
 * @param {string} text - Status text
 */
export function updateAutoStatus(statusIcon, statusText, icon, text) {
  if (statusIcon) statusIcon.textContent = icon;
  if (statusText) statusText.textContent = text;
}

/**
 * Build practice line CSS class
 * @param {Object} params - Parameters
 * @param {boolean} params.isStudentLine - Whether it's student's line
 * @param {boolean} params.isCurrent - Whether it's current line
 * @param {boolean} params.isCompleted - Whether it's completed
 * @param {boolean} params.isOtherSpeaker - Whether it's other speaker
 * @returns {string} - CSS class string
 */
export function buildPracticeLineClass({ isStudentLine, isCurrent, isCompleted, isOtherSpeaker }) {
  const classes = ['line-item'];
  if (isStudentLine) classes.push('my-role');
  if (isCurrent) classes.push('current');
  if (isCompleted) classes.push('practice-success');
  if (isOtherSpeaker) classes.push('other-speaker');
  return classes.join(' ');
}

/**
 * Build highlighted practice HTML with word-level feedback
 * @param {string} originalText - Original text
 * @param {Array} correctIndexes - Array of correct word indexes
 * @returns {string} - HTML string
 */
export function buildHighlightedPracticeHTML(originalText, correctIndexes) {
  if (!originalText) return '';
  const correctSet = new Set(correctIndexes || []);
  const segments = [];
  const wordRegex = /[A-Za-z0-9']+/g;
  let lastIndex = 0;
  let match = null;
  let wordIndex = 0;

  while ((match = wordRegex.exec(originalText)) !== null) {
    if (match.index > lastIndex) {
      segments.push(escapeHtml(originalText.slice(lastIndex, match.index)));
    }
    const wordText = match[0];
    const escapedWord = escapeHtml(wordText);
    if (correctSet.has(wordIndex)) {
      segments.push(`<span class="practice-word-correct">${escapedWord}</span>`);
    } else {
      segments.push(escapedWord);
    }
    lastIndex = match.index + wordText.length;
    wordIndex += 1;
  }

  if (lastIndex < originalText.length) {
    segments.push(escapeHtml(originalText.slice(lastIndex)));
  }

  return segments.join('');
}

/**
 * Render practice lines
 * @param {Object} state - Application state
 * @param {HTMLElement} practiceLineList - Practice line list element
 */
export function renderPracticeLines(state, practiceLineList) {
  if (!practiceLineList) return;
  practiceLineList.innerHTML = '';

  if (!state.currentSegments.length) {
    const li = document.createElement('li');
    li.className = 'line-item';
    li.textContent = '暂无字幕数据';
    practiceLineList.appendChild(li);
    return;
  }

  const studentLineIndexMap = new Map();
  state.practiceLines.forEach((line, idx) => {
    if (!line) return;
    const rawIndex = line.index != null ? line.index : line.segmentIndex;
    const key = buildSegmentKey(rawIndex);
    if (key) {
      studentLineIndexMap.set(key, idx);
    }
  });

  const total = state.currentSegments.length;

  state.currentSegments.forEach((segment, idx) => {
    const rawSegmentIndex = segment.index != null ? segment.index : idx;
    const normalizedSegmentIndex = normalizeSegmentIndex(rawSegmentIndex);
    const resultKey = buildSegmentKey(rawSegmentIndex);
    const studentIdx = resultKey ? studentLineIndexMap.get(resultKey) : undefined;
    const practiceLine = studentIdx != null ? state.practiceLines[studentIdx] : null;
    const isStudentLine = practiceLine != null;
    const canonicalSegmentIndex = normalizedSegmentIndex != null ? normalizedSegmentIndex : rawSegmentIndex;

    // In auto mode, use currentSegmentIndex to determine current line
    // In manual mode, use practiceIndex
    const isCurrent = state.autoMode
      ? canonicalSegmentIndex === state.currentSegmentIndex
      : (isStudentLine && studentIdx === state.practiceIndex);
    const isCompleted = resultKey ? state.practiceLineResults[resultKey] === 'success' : false;

    const li = document.createElement('li');
    li.className = buildPracticeLineClass({
      isStudentLine,
      isCurrent,
      isCompleted,
      isOtherSpeaker: !isStudentLine,
    });

    const speakerName = isStudentLine
      ? `[${practiceLine.speaker || state.selectedSpeaker}] - 你的角色`
      : (segment.speaker ? `[${segment.speaker}]` : '');

    if (speakerName) {
      const speakerEl = document.createElement('div');
      speakerEl.className = 'line-speaker';
      speakerEl.textContent = speakerName;
      li.appendChild(speakerEl);
    }

    const header = document.createElement('div');
    header.className = 'line-header';

    const lineNumber = document.createElement('span');
    lineNumber.className = 'line-number';
    lineNumber.textContent = `Line ${idx + 1} of ${total}`;
    header.appendChild(lineNumber);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'line-time';
    const start = Number(segment.start) || 0;
    const end = Number(segment.end != null ? segment.end : start);
    timeSpan.textContent = `${formatTime(start)} – ${formatTime(end)}`;
    header.appendChild(timeSpan);

    li.appendChild(header);

    const textEl = document.createElement('div');
    textEl.className = 'line-text';
    textEl.textContent = (practiceLine && practiceLine.text) || segment.text || '';
    li.appendChild(textEl);

    // Click handler
    li.addEventListener('click', () => {
      if (Number.isFinite(start) && window.videoPlayer) {
        window.videoPlayer.currentTime = start;
        if (typeof window.safePlayVideo === 'function') {
          window.safePlayVideo();
        }
      }
      if (isStudentLine) {
        state.practiceIndex = studentIdx;
        renderPracticeLines(state, practiceLineList);
        renderPracticeCurrentLine(state, window.practiceCurrentLine);
      } else if (canonicalSegmentIndex != null) {
        state.currentSegmentIndex = canonicalSegmentIndex;
        highlightCurrentSegment(state, canonicalSegmentIndex, practiceLineList);
      }
    });

    li.dataset.segmentIndex = resultKey || '';
    li.dataset.arrayIndex = String(idx);
    practiceLineList.appendChild(li);
  });

  // Scroll to current line
  let targetSegmentIndex = null;
  if (state.practiceLines.length) {
    const boundedIndex = Math.min(state.practiceIndex, state.practiceLines.length - 1);
    const currentLine = state.practiceLines[boundedIndex];
    if (currentLine) {
      targetSegmentIndex = currentLine.index != null ? currentLine.index : currentLine.segmentIndex;
      state.practiceIndex = boundedIndex;
    }
  } else if (state.currentSegments.length) {
    const fallback = state.currentSegments[Math.min(state.currentSegmentIndex || 0, state.currentSegments.length - 1)];
    if (fallback) {
      targetSegmentIndex = fallback.index != null ? fallback.index : state.currentSegments.indexOf(fallback);
    }
  }

  if (targetSegmentIndex != null) {
    highlightCurrentSegment(state, targetSegmentIndex, practiceLineList, false);
  } else {
    practiceLineList.querySelectorAll('.line-item').forEach((item) => item.classList.remove('current'));
  }

  renderPracticeCurrentLine(state, window.practiceCurrentLine);
}

/**
 * Render practice current line
 * @param {Object} state - Application state
 * @param {HTMLElement} practiceCurrentLine - Practice current line element
 */
export function renderPracticeCurrentLine(state, practiceCurrentLine) {
  if (!practiceCurrentLine) return;
  const line = state.practiceLines[state.practiceIndex];
  if (!line) {
    practiceCurrentLine.hidden = true;
    return;
  }

  const rawKey = line.index != null ? line.index : line.segmentIndex;
  const key = buildSegmentKey(rawKey);
  const isSuccessful = key ? state.practiceLineResults[key] === 'success' : false;
  const wordResult = key ? (state.practiceLineWordResults[key] || {}) : {};
  const highlighted = buildHighlightedPracticeHTML(line.text, wordResult.correctIndexes);

  practiceCurrentLine.hidden = false;
  practiceCurrentLine.className = `practice-current-line${isSuccessful ? ' practice-successful' : ''}`;
  practiceCurrentLine.innerHTML = `
    <div class="practice-current-meta">Line ${state.practiceIndex + 1} of ${state.practiceLines.length}</div>
    <div class="practice-current-text">${highlighted || escapeHtml(line.text || '')}</div>
    <div class="practice-current-time">${formatTime(line.start)} – ${formatTime(line.end)}</div>
  `;
}

/**
 * Highlight current segment
 * @param {Object} state - Application state
 * @param {number} segmentIndex - Segment index
 * @param {HTMLElement} practiceLineList - Practice line list element
 * @param {boolean} scroll - Whether to scroll to element
 */
export function highlightCurrentSegment(state, segmentIndex, practiceLineList, scroll = true) {
  const normalizedSegmentIndex = normalizeSegmentIndex(segmentIndex);
  const segmentKey = buildSegmentKey(segmentIndex);

  let targetArrayIndex = -1;
  if (Array.isArray(state.currentSegments) && state.currentSegments.length) {
    targetArrayIndex = state.currentSegments.findIndex((segment, idx) => {
      const idxValue = segment.index != null ? segment.index : idx;
      const normalizedIdxValue = normalizeSegmentIndex(idxValue);
      if (normalizedSegmentIndex !== null) {
        return normalizedIdxValue === normalizedSegmentIndex;
      }
      const candidateKey = buildSegmentKey(idxValue);
      if (segmentKey && candidateKey) {
        return candidateKey === segmentKey;
      }
      return normalizedIdxValue === null && idxValue === segmentIndex;
    });

    if (state.autoMode && targetArrayIndex >= 0) {
      state.autoSegmentCursor = targetArrayIndex;
    }
  }

  state.currentSegmentIndex = normalizedSegmentIndex != null ? normalizedSegmentIndex : segmentIndex;
  const studentIdx = segmentKey ? state.practiceLineIndexMap.get(segmentKey) : undefined;
  const practiceIndexChanged = studentIdx != null && state.practiceIndex !== studentIdx;

  practiceLineList.querySelectorAll('.line-item').forEach((item) => {
    const itemKey = item.dataset.segmentIndex;
    const itemArrayIndex = Number(item.dataset.arrayIndex);
    const normalizedItemKey = normalizeSegmentIndex(itemKey);
    const matchByNormalized = normalizedSegmentIndex !== null && normalizedItemKey === normalizedSegmentIndex;
    const matchByKey = normalizedSegmentIndex === null && segmentKey && itemKey === segmentKey;
    const matchByArrayIndex = Number.isInteger(itemArrayIndex) && itemArrayIndex === targetArrayIndex;

    if (matchByNormalized || matchByKey || matchByArrayIndex) {
      item.classList.add('current');
      if (scroll) {
        item.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } else {
      item.classList.remove('current');
    }
  });

  if (practiceIndexChanged) {
    state.practiceIndex = studentIdx;
    renderPracticeCurrentLine(state, window.practiceCurrentLine);
    updatePracticeProgress(state, window.practiceProgressChip);
  }
}

/**
 * Update practice progress
 * @param {Object} state - Application state
 * @param {HTMLElement} progressChip - Progress chip element
 */
export function updatePracticeProgress(state, progressChip) {
  if (!progressChip) return;

  const total = state.practiceLines.length;
  if (total === 0) {
    progressChip.hidden = true;
    return;
  }

  let completed = 0;
  state.practiceLines.forEach((line) => {
    const rawIndex = line.index != null ? line.index : line.segmentIndex;
    const key = buildSegmentKey(rawIndex);
    if (key && state.practiceLineResults[key] === 'success') {
      completed++;
    }
  });

  progressChip.hidden = false;
  progressChip.textContent = `${completed}/${total}`;
}

/**
 * Update video progress bar
 * @param {HTMLVideoElement} videoPlayer - Video element
 * @param {HTMLElement} progressFill - Progress fill element
 */
export function updateVideoProgress(videoPlayer, progressFill) {
  if (!videoPlayer || !progressFill) return;
  const progress = (videoPlayer.currentTime / videoPlayer.duration) * 100;
  progressFill.style.width = `${progress}%`;
}

/**
 * Update video time display
 * @param {HTMLVideoElement} videoPlayer - Video element
 * @param {HTMLElement} timeDisplay - Time display element
 */
export function updateVideoTime(videoPlayer, timeDisplay) {
  if (!videoPlayer || !timeDisplay) return;
  const current = formatTime(videoPlayer.currentTime);
  const duration = formatTime(videoPlayer.duration);
  timeDisplay.textContent = `${current} / ${duration}`;
}

/**
 * Populate speaker select dropdown
 * @param {Object} state - Application state
 * @param {HTMLSelectElement} speakerSelect - Speaker select element
 */
export function populateSpeakerSelect(state, speakerSelect) {
  const defaultOption = '<option value="">选择你要扮演的角色</option>';
  if (!state.speakers.length) {
    speakerSelect.innerHTML = defaultOption;
    speakerSelect.disabled = true;
    return;
  }

  const options = state.speakers
    .map((speaker, idx) => `<option value="${escapeHtml(speaker.speaker)}" ${idx === 0 ? 'selected' : ''}>${escapeHtml(speaker.speaker)}</option>`)
    .join('');
  speakerSelect.innerHTML = defaultOption + options;
  speakerSelect.disabled = false;
}

/**
 * Show loading overlay
 * @param {HTMLElement} overlay - Overlay element
 * @param {string} message - Loading message
 */
export function showLoading(overlay, message = '加载中....') {
  if (!overlay) return;
  overlay.textContent = message;
  overlay.style.display = 'flex';
}

/**
 * Hide loading overlay
 * @param {HTMLElement} overlay - Overlay element
 */
export function hideLoading(overlay) {
  if (!overlay) return;
  overlay.style.display = 'none';
}

/**
 * Show error message
 * @param {string} message - Error message
 */
export function showError(message) {
  if (window.Feedback) {
    Feedback.showToast('error', message);
  } else {
    alert(message);
  }
}

/**
 * Show success message
 * @param {string} message - Success message
 */
export function showSuccess(message) {
  if (window.Feedback) {
    Feedback.showToast('success', message);
  } else {
    console.log(message);
  }
}

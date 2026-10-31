/**
 * Main Entry Point for Practice Session
 * Coordinates all modules and initializes the application
 */

import { createInitialState } from './state.js';
import { AudioModeManager } from './audio-manager.js';
import {
  buildInferredSpeakers,
  inferDistinctSpeakersFromSegments
} from './speaker-inference.js';
import {
  startAutoMode,
  pauseAutoMode,
  resumeAutoMode,
  gotoPrevLine,
  gotoNextLine,
  moveToNextLine,
  startAutoRecording,
  updateAudioModeButtons,
  handleRecordingPassed,
  handleRecordingFailed,
  playOriginalThenNext
} from './controls.js';
import {
  updateAutoStatus,
  renderPracticeLines,
  renderPracticeCurrentLine,
  highlightCurrentSegment,
  updatePracticeProgress,
  updateVideoProgress,
  updateVideoTime,
  populateSpeakerSelect,
  showLoading,
  hideLoading,
  showError,
  showSuccess
} from './ui-manager.js';
import { evaluateRecording } from './evaluation.js';
import {
  fetchVideoData,
  fetchPracticeSpeakers,
  fetchUserRecordings,
  saveUserRecording,
  getAuthToken,
  setProtectedMediaSource
} from './api-client.js';
import {
  getSegmentLookupKeys,
  buildSegmentKey,
  normalizeSegmentIndex
} from './utils.js';

// Check for debug mode
const debugMode = window.location.search.includes('debug=1');

// Initialize global state
const state = createInitialState(debugMode);

// Initialize audio mode manager
const audioModeManager = new AudioModeManager();

if (window.LinglishMediaSession) {
  window.LinglishMediaSession.bindLifecycle({
    getToken: getAuthToken,
    onError: () => showError('媒体授权已失效，请重试'),
  });
}

// Make globally accessible for backward compatibility
window.state = state;
window.audioModeManager = audioModeManager;

/**
 * Initialize practice session
 */
async function initializePracticeSession() {
  console.log('[初始化] 开始初始化练习会话');

  // Get video ID from URL
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get('videoId');

  if (!videoId) {
    showError('缺少视频ID');
    return;
  }

  state.videoId = videoId;

  // Get DOM elements
  const elements = {
    videoPlayer: document.getElementById('video-player') || document.getElementById('practice-video'),
    practiceLineList: document.getElementById('practice-line-list'),
    practiceCurrentLine: document.getElementById('practice-current-line'),
    practiceSpeakerSelect: document.getElementById('practice-speaker-select'),
    autoPracticeStatus: document.getElementById('auto-practice-status'),
    statusIcon: document.getElementById('status-icon'),
    statusText: document.getElementById('status-text'),
    autoStartBtn: document.getElementById('auto-start-btn'),
    autoPauseBtn: document.getElementById('auto-pause-btn'),
    autoPrevBtn: document.getElementById('auto-prev-btn'),
    autoNextBtn: document.getElementById('auto-next-btn'),
    startRecordingFab: document.getElementById('start-recording-fab'),
    playOverlay: document.getElementById('play-overlay'),
    progressFill: document.querySelector('.video-progress-fill'),
    videoTime: document.getElementById('video-time'),
    practiceProgressChip: document.getElementById('practice-progress-chip'),
    audioModeBtns: Array.from(document.querySelectorAll('.audio-mode-btn')),
    loadingOverlay: document.getElementById('loading-overlay')
  };

  const missingCritical = [
    ['videoPlayer', elements.videoPlayer],
    ['practiceLineList', elements.practiceLineList],
    ['practiceSpeakerSelect', elements.practiceSpeakerSelect],
  ].filter(([, el]) => !el).map(([name]) => name);
  if (missingCritical.length) {
    showError(`练习页面结构不完整: ${missingCritical.join(', ')}`);
    return;
  }

  // Make globally accessible
  window.videoPlayer = elements.videoPlayer;
  window.practiceCurrentLine = elements.practiceCurrentLine;
  window.practiceProgressChip = elements.practiceProgressChip;

  // Show loading
  showLoading(elements.loadingOverlay, '加载视频数据...');

  try {
    // Fetch video data
    const videoData = await fetchVideoData(videoId);
    state.videoData = videoData;
    state.currentSegments = videoData.segments || [];

    console.log(`[初始化] 加载了 ${state.currentSegments.length} 个字幕段落`);

    // Set video source
    if (videoData.videoUrl) {
      await setProtectedMediaSource(elements.videoPlayer, videoData.videoUrl);
      elements.videoPlayer.load();
    }

    // Fetch speakers
    showLoading(elements.loadingOverlay, '加载角色信息...');
    const speakersData = await fetchPracticeSpeakers(videoId);
    state.speakers = speakersData.speakers || [];
    state.hasServerSpeakers = state.speakers.length > 0;

    // If no server speakers, build inferred speakers
    if (!state.hasServerSpeakers && state.currentSegments.length > 0) {
      console.log('[初始化] 服务器没有提供角色信息，使用推断模式');
      buildInferredSpeakers(state, getSegmentLookupKeys, console.log, debugMode);
    }

    populateSpeakerSelect(state, elements.practiceSpeakerSelect);

    // Fetch user recordings
    showLoading(elements.loadingOverlay, '加载用户录音...');
    const recordings = await fetchUserRecordings(videoId);
    state.serverRecordings = recordings || [];

    // Load recordings into audio manager
    audioModeManager.loadUserRecordings(videoId, state.serverRecordings);

    // Hide loading
    hideLoading(elements.loadingOverlay);

    // Render initial UI
    renderPracticeLines(state, elements.practiceLineList);

    console.log('[初始化] 练习会话初始化完成');

  } catch (error) {
    console.error('[初始化] 失败:', error);
    showError('加载失败: ' + error.message);
    hideLoading(elements.loadingOverlay);
  }

  // Set up event listeners
  setupEventListeners(elements);
}

/**
 * Set up event listeners
 * @param {Object} elements - DOM elements
 */
function setupEventListeners(elements) {
  // Speaker selection
  elements.practiceSpeakerSelect.addEventListener('change', (e) => {
    const speakerName = e.target.value;
    if (speakerName) {
      setPracticeSpeaker(speakerName, elements);
    }
  });

  // Auto mode controls
  elements.autoStartBtn.addEventListener('click', () => {
    if (state.autoMode && state.isPaused) {
      resumeAutoMode(state, elements, autoPlayCurrentSegment, updateAutoStatusWrapper);
    } else {
      startAutoMode(state, elements.videoPlayer, elements, autoPlayCurrentSegment, updateAutoStatusWrapper, () => renderPracticeLines(state, elements.practiceLineList));
    }
  });

  elements.autoPauseBtn.addEventListener('click', () => {
    pauseAutoMode(state, elements.videoPlayer, elements, updateAutoStatusWrapper);
  });

  elements.autoPrevBtn.addEventListener('click', () => {
    gotoPrevLine(state, elements.videoPlayer, highlightCurrentSegmentWrapper, autoPlayCurrentSegment, updateAutoStatusWrapper);
  });

  elements.autoNextBtn.addEventListener('click', () => {
    gotoNextLine(state, elements.videoPlayer, highlightCurrentSegmentWrapper, autoPlayCurrentSegment, updateAutoStatusWrapper);
  });

  // Standalone recording button
  elements.startRecordingFab.addEventListener('click', () => {
    startAutoRecording(state, updateAutoStatusWrapper, handleRecordingCompleteWrapper);
  });

  // Audio mode buttons
  elements.audioModeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode || 'original';
      audioModeManager.setMode(mode);
      updateAudioModeButtons(audioModeManager, elements.audioModeBtns);
    });
  });

  // Video events
  elements.videoPlayer.addEventListener('timeupdate', () => {
    updateVideoProgress(elements.videoPlayer, elements.progressFill);
    updateVideoTime(elements.videoPlayer, elements.videoTime);

    // Check segment playback end
    if (state.segmentPlaybackEnd && elements.videoPlayer.currentTime >= state.segmentPlaybackEnd) {
      if (state.segmentPlaybackCallback) {
        state.segmentPlaybackCallback();
      }
      state.segmentPlaybackEnd = null;
      state.segmentPlaybackCallback = null;
    }
  });

  // Video progress bar click
  const progressBar = document.querySelector('.video-progress');
  if (progressBar) {
    progressBar.addEventListener('click', (e) => {
      const rect = progressBar.getBoundingClientRect();
      const pos = (e.clientX - rect.left) / rect.width;
      elements.videoPlayer.currentTime = pos * elements.videoPlayer.duration;
    });
  }

  // Play overlay click
  if (elements.playOverlay) {
    elements.playOverlay.addEventListener('click', () => {
      if (typeof window.safePlayVideo === 'function') {
        window.safePlayVideo();
      } else {
        elements.videoPlayer.play();
      }
      elements.playOverlay.style.display = 'none';
    });
  }

  console.log('[事件监听] 所有事件监听器已设置');
}

/**
 * Set practice speaker
 * @param {string} speakerName - Speaker name
 * @param {Object} elements - DOM elements
 */
function setPracticeSpeaker(speakerName, elements) {
  state.selectedSpeaker = speakerName;
  const speakerData = state.speakers.find((item) => item.speaker === speakerName);
  state.practiceLines = speakerData?.lines || [];

  // Reset state
  state.practiceIndex = 0;
  state.autoSegmentCursor = 0;
  state.practiceAttempts = 0;
  state.practiceLineResults = {};
  state.practiceLineWordResults = {};

  // Update audio manager
  audioModeManager.selectedSpeaker = speakerName;
  audioModeManager.loadUserRecordings(state.videoId, state.serverRecordings || []);

  // Render UI
  renderPracticeLines(state, elements.practiceLineList);
  renderPracticeCurrentLine(state, elements.practiceCurrentLine);
  updatePracticeProgress(state, elements.practiceProgressChip);

  // Show recording button
  if (elements.startRecordingFab) {
    elements.startRecordingFab.hidden = false;
  }

  console.log(`[角色选择] 已选择: ${speakerName}, 台词数: ${state.practiceLines.length}`);
}

/**
 * Auto play current segment
 */
function autoPlayCurrentSegment() {
  if (state.isPaused) return;

  const allSegments = state.currentSegments;
  if (!allSegments || !allSegments.length) return;

  const pointer = state.autoSegmentCursor;
  if (pointer >= allSegments.length) {
    updateAutoStatusWrapper('🎉', '恭喜完成所有对话！');
    state.autoMode = false;
    return;
  }

  const currentLine = allSegments[pointer];
  if (!currentLine) return;

  const segmentIndex = currentLine.index != null ? currentLine.index : pointer;
  highlightCurrentSegmentWrapper(segmentIndex, true);

  // Check if this is user's line
  const isUserLine = checkIfUserLine(currentLine, segmentIndex);

  console.log(`[自动播放] 第${pointer}句, isUserLine: ${isUserLine}`);

  if (isUserLine) {
    updateAutoStatusWrapper('🎭', '轮到你了！');
    if (window.Feedback) window.Feedback.playSfx('prompt');
    setTimeout(() => {
      if (!state.isPaused) {
        startAutoRecording(state, updateAutoStatusWrapper, handleRecordingCompleteWrapper);
      }
    }, 1000);
  } else {
    playNonUserLine(currentLine);
  }
}

/**
 * Check if line is user's line
 * @param {Object} line - Line object
 * @param {number} segmentIndex - Segment index
 * @returns {boolean} - True if user's line
 */
function checkIfUserLine(line, segmentIndex) {
  const speaker = line.speaker || '';
  if (speaker && state.selectedSpeaker && speaker === state.selectedSpeaker) {
    return true;
  }

  const segmentKey = buildSegmentKey(segmentIndex);
  if (segmentKey && state.segmentSpeakerMap.has(segmentKey)) {
    return state.segmentSpeakerMap.get(segmentKey) === state.selectedSpeaker;
  }

  return false;
}

/**
 * Play non-user line
 * @param {Object} line - Line object
 */
function playNonUserLine(line) {
  const start = Number(line.start) || 0;
  const end = Number(line.end);
  const effectiveEnd = Number.isFinite(end) ? end : start + 4;

  state.segmentPlaybackEnd = effectiveEnd;
  state.segmentPlaybackCallback = () => {
    window.videoPlayer.pause();
    moveToNextLineWrapper();
  };

  window.videoPlayer.currentTime = start;
  if (typeof window.safePlayVideo === 'function') {
    window.safePlayVideo();
  } else {
    window.videoPlayer.play();
  }

  updateAutoStatusWrapper('🎬', `${line.speaker || '其他角色'}正在说话...`);
}

/**
 * Handle recording complete
 * @param {Blob} blob - Recording blob
 */
async function handleRecordingCompleteWrapper(blob) {
  const line = state.currentSegments[state.autoSegmentCursor];
  if (!line) return;

  try {
    const result = await evaluateRecording(line, blob);

    // Save recording
    const segmentIndex = line.index != null ? line.index : state.autoSegmentCursor;
    await saveUserRecording(state.videoId, segmentIndex, result.blob, {
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      speaker: state.selectedSpeaker
    });

    // Handle result
    if (result.passed) {
      handleRecordingPassed(
        state,
        line,
        updateAutoStatusWrapper,
        () => updatePracticeProgress(state, window.practiceProgressChip),
        moveToNextLineWrapper
      );
    } else {
      handleRecordingFailed(
        state,
        updateAutoStatusWrapper,
        () => startAutoRecording(state, updateAutoStatusWrapper, handleRecordingCompleteWrapper),
        () => playOriginalThenNext(state, window.videoPlayer, window.safePlayVideo, moveToNextLineWrapper, updateAutoStatusWrapper),
        result // Pass evaluation result for detailed feedback
      );
    }
  } catch (error) {
    console.error('[录音处理] 失败:', error);
    handleRecordingFailed(
      state,
      updateAutoStatusWrapper,
      () => startAutoRecording(state, updateAutoStatusWrapper, handleRecordingCompleteWrapper),
      () => playOriginalThenNext(state, window.videoPlayer, window.safePlayVideo, moveToNextLineWrapper, updateAutoStatusWrapper)
    );
  }
}

/**
 * Wrapper functions for easier passing to other modules
 */
function updateAutoStatusWrapper(icon, text) {
  const elements = {
    statusIcon: document.getElementById('status-icon'),
    statusText: document.getElementById('status-text')
  };
  updateAutoStatus(elements.statusIcon, elements.statusText, icon, text);
}

function highlightCurrentSegmentWrapper(segmentIndex, scroll = true) {
  const practiceLineList = document.getElementById('practice-line-list');
  highlightCurrentSegment(state, segmentIndex, practiceLineList, scroll);
}

function moveToNextLineWrapper() {
  const elements = {
    autoStartBtn: document.getElementById('auto-start-btn'),
    autoPauseBtn: document.getElementById('auto-pause-btn')
  };
  moveToNextLine(state, elements, autoPlayCurrentSegment, highlightCurrentSegmentWrapper, updateAutoStatusWrapper);
}

// Initialize on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePracticeSession);
} else {
  initializePracticeSession();
}

// Export for testing and debugging
export {
  state,
  audioModeManager,
  initializePracticeSession
};

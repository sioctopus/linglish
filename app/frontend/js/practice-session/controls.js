/**
 * Controls Module
 * Handles control panel logic, auto mode, navigation, and recording controls
 */

import { startVADMonitoring, stopVADMonitoring, requestMicPermission } from './audio-manager.js';
import { evaluateRecording, generateFeedback } from './evaluation.js';
import { showFeedbackModal } from './feedback-modal.js';

/**
 * Start auto mode
 * @param {Object} state - Application state
 * @param {HTMLVideoElement} videoPlayer - Video element
 * @param {Object} elements - UI elements
 * @param {Function} autoPlayCurrentSegment - Function to play current segment
 * @param {Function} updateAutoStatus - Function to update status
 * @param {Function} renderPracticeLines - Function to render lines
 */
export function startAutoMode(state, videoPlayer, elements, autoPlayCurrentSegment, updateAutoStatus, renderPracticeLines) {
  if (!state.selectedSpeaker) {
    alert('请先选择你要扮演的角色');
    return;
  }

  if (!state.currentSegments || state.currentSegments.length === 0) {
    alert('没有可用的对话内容');
    return;
  }

  state.autoMode = true;
  state.isPaused = false;
  state.autoSegmentCursor = 0;
  state.practiceIndex = 0;
  state.currentRetry = 0;

  // Hide standalone recording button
  if (elements.startRecordingFab) elements.startRecordingFab.hidden = true;

  // Show auto control panel
  if (elements.autoPracticeStatus) elements.autoPracticeStatus.hidden = false;
  if (elements.autoStartBtn) elements.autoStartBtn.hidden = true;
  if (elements.autoPauseBtn) elements.autoPauseBtn.hidden = false;

  // Pause video and hide overlay
  videoPlayer.pause();
  if (elements.playOverlay) elements.playOverlay.style.display = 'none';

  // Re-render to show correct highlighting
  renderPracticeLines();

  updateAutoStatus('🎬', '开始角色扮演...');

  setTimeout(() => {
    autoPlayCurrentSegment();
  }, 1000);
}

/**
 * Pause auto mode
 * @param {Object} state - Application state
 * @param {HTMLVideoElement} videoPlayer - Video element
 * @param {Object} elements - UI elements
 * @param {Function} updateAutoStatus - Function to update status
 */
export function pauseAutoMode(state, videoPlayer, elements, updateAutoStatus) {
  state.isPaused = true;

  // Stop recording
  if (state.isRecording) {
    stopVADMonitoring(state);
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.stop();
    }
    state.isRecording = false;
  }

  // Pause video
  videoPlayer.pause();

  // Update button state
  if (elements.autoStartBtn) {
    elements.autoStartBtn.hidden = false;
    elements.autoStartBtn.textContent = '▶';
  }
  if (elements.autoPauseBtn) elements.autoPauseBtn.hidden = true;

  updateAutoStatus('⏸', '已暂停');
}

/**
 * Resume auto mode
 * @param {Object} state - Application state
 * @param {Object} elements - UI elements
 * @param {Function} autoPlayCurrentSegment - Function to play current segment
 * @param {Function} updateAutoStatus - Function to update status
 */
export function resumeAutoMode(state, elements, autoPlayCurrentSegment, updateAutoStatus) {
  if (!state.autoMode) return;

  state.isPaused = false;

  // Update button state
  if (elements.autoStartBtn) elements.autoStartBtn.hidden = true;
  if (elements.autoPauseBtn) elements.autoPauseBtn.hidden = false;

  updateAutoStatus('▶', '继续...');

  setTimeout(() => {
    autoPlayCurrentSegment();
  }, 500);
}

/**
 * Go to previous line
 * @param {Object} state - Application state
 * @param {HTMLVideoElement} videoPlayer - Video element
 * @param {Function} highlightCurrentSegment - Function to highlight segment
 * @param {Function} autoPlayCurrentSegment - Function to play current segment
 * @param {Function} updateAutoStatus - Function to update status
 */
export function gotoPrevLine(state, videoPlayer, highlightCurrentSegment, autoPlayCurrentSegment, updateAutoStatus) {
  if (state.autoSegmentCursor <= 0) {
    updateAutoStatus('ℹ️', '已经是第一句了');
    return;
  }

  // Stop current operations
  if (state.isRecording) {
    stopVADMonitoring(state);
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.stop();
    }
    state.isRecording = false;
  }

  videoPlayer.pause();

  // Go to previous line
  state.autoSegmentCursor = Math.max(0, state.autoSegmentCursor - 1);
  state.currentRetry = 0;

  // Highlight current segment
  const prevLine = state.currentSegments[state.autoSegmentCursor];
  if (prevLine) {
    const segmentIndex = prevLine.index != null ? prevLine.index : state.autoSegmentCursor;
    highlightCurrentSegment(segmentIndex, true);
  }

  updateAutoStatus('⏮', '回到上一句');

  // Continue if not paused
  if (!state.isPaused) {
    setTimeout(() => {
      autoPlayCurrentSegment();
    }, 1000);
  }
}

/**
 * Go to next line
 * @param {Object} state - Application state
 * @param {HTMLVideoElement} videoPlayer - Video element
 * @param {Function} highlightCurrentSegment - Function to highlight segment
 * @param {Function} autoPlayCurrentSegment - Function to play current segment
 * @param {Function} updateAutoStatus - Function to update status
 */
export function gotoNextLine(state, videoPlayer, highlightCurrentSegment, autoPlayCurrentSegment, updateAutoStatus) {
  if (state.autoSegmentCursor >= state.currentSegments.length - 1) {
    updateAutoStatus('ℹ️', '已经是最后一句了');
    return;
  }

  // Stop current operations
  if (state.isRecording) {
    stopVADMonitoring(state);
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.stop();
    }
    state.isRecording = false;
  }

  videoPlayer.pause();

  // Go to next line
  state.autoSegmentCursor = Math.min(state.autoSegmentCursor + 1, state.currentSegments.length - 1);
  state.currentRetry = 0;

  // Highlight current segment
  const nextLine = state.currentSegments[state.autoSegmentCursor];
  if (nextLine) {
    const segmentIndex = nextLine.index != null ? nextLine.index : state.autoSegmentCursor;
    highlightCurrentSegment(segmentIndex, true);
  }

  updateAutoStatus('⏭', '跳到下一句');

  // Continue if not paused
  if (!state.isPaused) {
    setTimeout(() => {
      autoPlayCurrentSegment();
    }, 1000);
  }
}

/**
 * Move to next line after success
 * @param {Object} state - Application state
 * @param {Object} elements - UI elements
 * @param {Function} autoPlayCurrentSegment - Function to play current segment
 * @param {Function} highlightCurrentSegment - Function to highlight segment
 * @param {Function} updateAutoStatus - Function to update status
 */
export function moveToNextLine(state, elements, autoPlayCurrentSegment, highlightCurrentSegment, updateAutoStatus) {
  if (state.autoSegmentCursor >= state.currentSegments.length - 1) {
    // Reached the end
    updateAutoStatus('🎉', '恭喜完成所有对话！');
    state.autoMode = false;
    if (elements.autoStartBtn) {
      elements.autoStartBtn.hidden = false;
      elements.autoStartBtn.textContent = '▶';
    }
    if (elements.autoPauseBtn) elements.autoPauseBtn.hidden = true;
    return;
  }

  state.autoSegmentCursor = Math.min(state.autoSegmentCursor + 1, state.currentSegments.length - 1);
  state.currentRetry = 0;

  // Highlight next segment
  const nextLine = state.currentSegments[state.autoSegmentCursor];
  if (nextLine) {
    const segmentIndex = nextLine.index != null ? nextLine.index : state.autoSegmentCursor;
    highlightCurrentSegment(segmentIndex, true);
  }

  // Continue auto process if not paused
  if (!state.isPaused) {
    setTimeout(() => {
      autoPlayCurrentSegment();
    }, 500);
  }
}

/**
 * Start auto recording
 * @param {Object} state - Application state
 * @param {Function} updateAutoStatus - Function to update status
 * @param {Function} handleRecordingComplete - Function to handle recording complete
 * @returns {Promise} - Promise that resolves when recording starts
 */
export async function startAutoRecording(state, updateAutoStatus, handleRecordingComplete) {
  try {
    // Request microphone permission if needed
    if (!state.mediaStream) {
      updateAutoStatus('🎤', '请求麦克风权限...');
      state.mediaStream = await requestMicPermission();
    }

    // Initialize audio analyser for VAD
    if (!state.audioAnalyser) {
      const { initializeAudioAnalyser } = await import('./audio-manager.js');
      await initializeAudioAnalyser(state);
    }

    // Determine best MIME type
    let mimeType = '';
    if (MediaRecorder.isTypeSupported('audio/mp4')) {
      mimeType = 'audio/mp4';
    } else if (MediaRecorder.isTypeSupported('audio/mpeg')) {
      mimeType = 'audio/mpeg';
    } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      mimeType = 'audio/webm;codecs=opus';
    }

    // Create MediaRecorder
    if (mimeType) {
      state.recorder = new MediaRecorder(state.mediaStream, { mimeType });
    } else {
      state.recorder = new MediaRecorder(state.mediaStream);
    }

    state.recordingChunks = [];
    state.recorderMimeType = mimeType || state.recorder.mimeType;

    state.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        state.recordingChunks.push(event.data);
      }
    };

    state.recorder.onstop = () => {
      const blob = new Blob(state.recordingChunks, { type: state.recorderMimeType });
      state.lastRecordingBlob = blob;
      state.isRecording = false;
      handleRecordingComplete(blob);
    };

    state.recorder.onerror = (error) => {
      console.error('[录音] MediaRecorder error:', error);
      state.isRecording = false;
      updateAutoStatus('❌', '录音失败，请重试');
    };

    // Start recording
    state.recorder.start();
    state.isRecording = true;
    state.recordingStartAt = Date.now();
    state.firstVoiceAt = null;
    state.voicedMs = 0;
    try {
      if (typeof window !== 'undefined'
        && window.LinglishAudioCues
        && typeof window.LinglishAudioCues.playMicReadyCue === 'function') {
        window.LinglishAudioCues.playMicReadyCue();
      }
    } catch (_) {}

    updateAutoStatus('🎤', '正在录音，请说话...');

    // Start VAD monitoring
    startVADMonitoring(state, () => {
      // Stop recording on silence detected
      if (state.recorder && state.recorder.state !== 'inactive') {
        state.recorder.stop();
      }
    });

  } catch (error) {
    console.error('[录音] 启动失败:', error);
    updateAutoStatus('❌', '录音失败，请检查麦克风权限');
    state.isRecording = false;

    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      alert('需要麦克风权限才能录音，请在浏览器设置中允许麦克风访问。');
    }
  }
}

/**
 * Stop auto recording manually
 * @param {Object} state - Application state
 */
export function stopAutoRecording(state) {
  stopVADMonitoring(state);
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }
  state.isRecording = false;
}

/**
 * Update audio mode buttons
 * @param {Object} audioModeManager - Audio mode manager instance
 * @param {Array} audioModeBtns - Array of audio mode button elements
 */
export function updateAudioModeButtons(audioModeManager, audioModeBtns) {
  const currentMode = audioModeManager.mode;
  const recordingCount = audioModeManager.getRecordingCount();

  audioModeBtns.forEach((btn) => {
    const mode = btn.dataset.mode || 'original';
    btn.classList.toggle('active', mode === currentMode);
    btn.disabled = recordingCount === 0 && mode !== 'original';
  });
}

/**
 * Ensure audio mode availability
 * @param {Object} audioModeManager - Audio mode manager instance
 * @param {Array} audioModeBtns - Array of audio mode button elements
 */
export function ensureAudioModeAvailability(audioModeManager, audioModeBtns) {
  const recordingCount = audioModeManager.getRecordingCount();

  audioModeBtns.forEach((btn) => {
    const mode = btn.dataset.mode || 'original';
    btn.disabled = recordingCount === 0 && mode !== 'original';
  });
}

/**
 * Handle recording passed
 * @param {Object} state - Application state
 * @param {Object} line - Practice line
 * @param {Function} updateAutoStatus - Function to update status
 * @param {Function} updatePracticeProgress - Function to update progress
 * @param {Function} moveToNextLine - Function to move to next line
 */
export function handleRecordingPassed(state, line, updateAutoStatus, updatePracticeProgress, moveToNextLine) {
  console.log('[评分] 通过！');
  updateAutoStatus('✅', '太棒了！继续下一句');

  // Show feedback
  if (window.Feedback) {
    const msg = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('feedback.line_passed') || '本句通过！') : '本句通过！';
    Feedback.showToast('success', `✅ ${msg}`);
    Feedback.playSfx('success');
  }

  state.currentRetry = 0; // Reset retry count

  // Mark current segment as success
  const currentLine = state.currentSegments[state.autoSegmentCursor];
  if (currentLine) {
    const segmentIndex = currentLine.index != null ? currentLine.index : state.autoSegmentCursor;
    state.practiceLineResults[segmentIndex] = 'success';
  }

  // Update progress and badges
  try {
    state.consecutiveSuccess = (state.consecutiveSuccess || 0) + 1;
    if (state.consecutiveSuccess === 3) {
      window.Feedback && Feedback.awardBadgeOnce('flow-3', '流畅三连');
    } else if (state.consecutiveSuccess === 5) {
      window.Feedback && Feedback.awardBadgeOnce('flow-5', '五连击');
    }
  } catch (_) {}

  updatePracticeProgress();

  // Auto move to next line if not paused
  if (!state.isPaused) {
    setTimeout(() => {
      moveToNextLine();
    }, 1500);
  }
}

/**
 * Handle recording failed with detailed feedback modal
 * @param {Object} state - Application state
 * @param {Function} updateAutoStatus - Function to update status
 * @param {Function} startAutoRecording - Function to start recording
 * @param {Function} playOriginalThenNext - Function to play original then next
 * @param {Object} evaluationResult - Evaluation result with score, words, hypothesis
 */
export async function handleRecordingFailed(state, updateAutoStatus, startAutoRecording, playOriginalThenNext, evaluationResult = null) {
  state.consecutiveSuccess = 0;

  // Get current line info
  const currentLine = state.currentSegments[state.autoSegmentCursor];
  const referenceText = currentLine?.text || currentLine?.content || '';

  // If we have evaluation result with score < 80%, show detailed feedback modal
  if (evaluationResult && evaluationResult.score < 0.8 && referenceText) {
    console.log(`[评分] 显示详细反馈，准确度: ${Math.round(evaluationResult.score * 100)}%`);

    const feedback = generateFeedback(evaluationResult.score, evaluationResult.words || []);
    updateAutoStatus(feedback.emoji, feedback.text);

    try {
      // Show feedback modal and wait for user choice
      const userChoice = await showFeedbackModal({
        score: evaluationResult.score,
        referenceText,
        words: evaluationResult.words || [],
        hypothesis: evaluationResult.hypothesis || '',
        feedback
      });

      if (userChoice === 'retry') {
        // User chose to retry
        state.currentRetry++;
        console.log(`[评分] 用户选择重试，第${state.currentRetry}次尝试`);
        updateAutoStatus('🎤', '准备重新录音...');

        if (!state.isPaused) {
          setTimeout(() => {
            startAutoRecording();
          }, 500);
        }
      } else {
        // User chose to continue to next
        console.log('[评分] 用户选择继续下一句');
        state.currentRetry = 0;
        updateAutoStatus('▶️', '继续下一句');

        if (!state.isPaused) {
          // Import moveToNextLine dynamically to avoid circular dependency
          const { moveToNextLine } = await import('./controls.js');
          setTimeout(() => {
            // This will be handled by the caller
            playOriginalThenNext();
          }, 500);
        }
      }
      return;
    } catch (modalErr) {
      console.error('[评分] 反馈模态框错误:', modalErr);
      // Fall through to legacy behavior on error
    }
  }

  // Legacy behavior for cases without evaluation result
  state.currentRetry++;
  console.log(`[评分] 失败，第${state.currentRetry}次尝试`);

  if (state.currentRetry >= state.maxRetries) {
    // Failed 3 times, play original
    updateAutoStatus('📢', '让我们听听原声...');
    if (!state.isPaused) {
      setTimeout(() => {
        playOriginalThenNext();
      }, 1000);
    }
  } else {
    // Still have chances, try again
    updateAutoStatus('🔄', `再试一次！(${state.currentRetry}/${state.maxRetries})`);
    if (!state.isPaused) {
      setTimeout(() => {
        startAutoRecording();
      }, 2000);
    }
  }
}

/**
 * Play original audio then move to next
 * @param {Object} state - Application state
 * @param {HTMLVideoElement} videoPlayer - Video element
 * @param {Function} safePlayVideo - Function to safely play video
 * @param {Function} moveToNextLine - Function to move to next line
 * @param {Function} updateAutoStatus - Function to update status
 */
export function playOriginalThenNext(state, videoPlayer, safePlayVideo, moveToNextLine, updateAutoStatus) {
  const line = state.currentSegments[state.autoSegmentCursor];
  if (!line) return;

  const start = Number(line.start) || 0;
  const end = Number(line.end);
  const effectiveEnd = Number.isFinite(end) ? end : start + 4;

  state.segmentPlaybackEnd = effectiveEnd;
  state.segmentPlaybackCallback = () => {
    videoPlayer.pause();
    state.currentRetry = 0;
    moveToNextLine();
  };

  videoPlayer.currentTime = start;

  // Use mobile-friendly playback strategy
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|Windows Phone|Mobi/i.test(navigator.userAgent);
  if (isMobile) {
    const targetVol = Number.isFinite(videoPlayer.volume) ? (videoPlayer.volume || 1) : 1;
    const prevMuted = videoPlayer.muted;
    videoPlayer.muted = true;
    safePlayVideo({ preferUnmuted: false }).then(() => {
      setTimeout(() => {
        try {
          const { smoothUnmute, DUCK_FADE_MS } = require('./audio-manager.js');
          smoothUnmute(videoPlayer, targetVol, DUCK_FADE_MS);
        } catch (_) {
          videoPlayer.muted = false;
        }
      }, 140);
    });
    // Multiple gentle retries for strict policies
    [260, 800, 1500].forEach((ms) => {
      setTimeout(() => {
        if (videoPlayer.paused) safePlayVideo({ preferUnmuted: false });
      }, ms);
    });
  } else {
    safePlayVideo();
    // Fallback: retry with muted if failed
    setTimeout(() => {
      if (videoPlayer.paused) safePlayVideo({ preferUnmuted: false });
    }, 220);
  }

  updateAutoStatus('🎵', '播放原声中...');
}

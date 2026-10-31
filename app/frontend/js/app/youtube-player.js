/**
 * YouTube Player Integration
 * Handles YouTube IFrame API and playback control
 * Note: Mainland China users will use local video playback instead
 */

function getYouTubeOrigin() {
  if (window.location.origin && window.location.origin !== 'null') {
    return window.location.origin;
  }
  if (window.location.protocol && window.location.host) {
    return `${window.location.protocol}//${window.location.host}`;
  }
  return 'http://localhost:4000';
}

class YouTubePlayer {
  constructor(containerId) {
    this.containerId = containerId;
    this.player = null;
    this.ready = false;
    this.videoId = null;
    this.onReadyCallback = null;
    this.onStateChangeCallback = null;
    this.onTimeUpdateCallback = null;
    this.timeUpdateInterval = null;
    this._suppressPauseOverlayUntil = 0;
    this._initGeneration = 0;
    this._destroyed = false;
    this._cancelInit = null;
    this._nativeCaptionsWanted = false;
  }

  _createInitCancelledError() {
    const error = new Error('YouTube player initialization cancelled');
    error.code = 'YOUTUBE_INIT_CANCELLED';
    return error;
  }

  _isInitCancelled(generation) {
    return this._destroyed || generation !== this._initGeneration;
  }

  /**
   * Load YouTube IFrame API script with timeout and retry
   */
  loadYouTubeAPI(retryCount = 0, generation = this._initGeneration) {
    const MAX_RETRIES = 3;
    const TIMEOUT_MS = 30000; // 30 seconds timeout (increased from 10s)

    return new Promise((resolve, reject) => {
      const rejectIfCancelled = () => {
        if (!this._isInitCancelled(generation)) return false;
        reject(this._createInitCancelledError());
        return true;
      };
      if (rejectIfCancelled()) return;

      // Check if API is already loaded
      if (window.YT && window.YT.Player) {
        console.log('[YouTube API] Already loaded');
        this.ready = true;
        resolve();
        return;
      }

      console.log(`[YouTube API] Loading... (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);

      let timeoutId = null;
      let checkInterval = null;
      let scriptTag = null;
      let isResolved = false;

      // Cleanup function
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        if (scriptTag && scriptTag.parentNode) {
          scriptTag.onerror = null;
          scriptTag.onload = null;
        }
      };

      // Success handler
      const handleSuccess = () => {
        if (isResolved) return;
        if (this._isInitCancelled(generation)) {
          isResolved = true;
          cleanup();
          reject(this._createInitCancelledError());
          return;
        }
        isResolved = true;
        cleanup();

        console.log('[YouTube API] Successfully loaded');
        this.ready = true;
        resolve();
      };

      // Periodically check if YT.Player is available (fallback detection)
      checkInterval = setInterval(() => {
        if (this._isInitCancelled(generation)) {
          isResolved = true;
          cleanup();
          reject(this._createInitCancelledError());
          return;
        }
        if (window.YT && window.YT.Player) {
          console.log('[YouTube API] Detected via polling');
          handleSuccess();
        }
      }, 500);

      // Timeout handler
      timeoutId = setTimeout(() => {
        if (isResolved) return;
        if (this._isInitCancelled(generation)) {
          isResolved = true;
          cleanup();
          reject(this._createInitCancelledError());
          return;
        }

        // Final check before timing out
        if (window.YT && window.YT.Player) {
          console.log('[YouTube API] Found on final check before timeout');
          handleSuccess();
          return;
        }

        console.warn(`[YouTube API] Load timeout (attempt ${retryCount + 1})`);
        console.warn('[YouTube API] Debug info:', {
          hasYT: !!window.YT,
          hasPlayer: !!(window.YT && window.YT.Player),
          scriptLoaded: !!scriptTag
        });
        cleanup();

        // Retry if we haven't exceeded max retries
        if (retryCount < MAX_RETRIES) {
          console.log('[YouTube API] Retrying...');
          this.loadYouTubeAPI(retryCount + 1, generation)
            .then(resolve)
            .catch(reject);
        } else {
          reject(new Error('YouTube API failed to load after multiple attempts. Please check your network connection or try disabling browser extensions that might block YouTube.'));
        }
      }, TIMEOUT_MS);

      // Create script tag
      scriptTag = document.createElement('script');
      scriptTag.src = 'https://www.youtube.com/iframe_api';
      scriptTag.async = true;
      scriptTag.defer = true;

      // Script load handler (script tag loaded, but API may not be ready yet)
      scriptTag.onload = () => {
        console.log('[YouTube API] Script tag loaded, waiting for YT.Player...');
      };

      // Error handler
      scriptTag.onerror = (error) => {
        if (isResolved) return;
        if (this._isInitCancelled(generation)) {
          isResolved = true;
          cleanup();
          reject(this._createInitCancelledError());
          return;
        }

        console.error(`[YouTube API] Script load error (attempt ${retryCount + 1}):`, error);
        cleanup();

        // Retry if we haven't exceeded max retries
        if (retryCount < MAX_RETRIES) {
          console.log('[YouTube API] Retrying after error...');
          setTimeout(() => {
            if (this._isInitCancelled(generation)) {
              reject(this._createInitCancelledError());
              return;
            }
            this.loadYouTubeAPI(retryCount + 1, generation)
              .then(resolve)
              .catch(reject);
          }, 1000 * (retryCount + 1)); // Exponential backoff: 1s, 2s, 3s
        } else {
          isResolved = true;
          reject(new Error('YouTube API script failed to load. Please check your network connection, disable ad blockers, or try a different browser.'));
        }
      };

      // YouTube API ready callback
      const originalCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        console.log('[YouTube API] onYouTubeIframeAPIReady called');

        // Call original callback if it exists
        if (originalCallback && typeof originalCallback === 'function') {
          try {
            originalCallback();
          } catch (e) {
            console.warn('[YouTube API] Original callback error:', e);
          }
        }

        handleSuccess();
      };

      // Insert script into page
      try {
        const firstScriptTag = document.getElementsByTagName('script')[0];
        if (firstScriptTag && firstScriptTag.parentNode) {
          firstScriptTag.parentNode.insertBefore(scriptTag, firstScriptTag);
        } else {
          // Fallback: append to head
          document.head.appendChild(scriptTag);
        }
      } catch (insertError) {
        console.error('[YouTube API] Failed to insert script:', insertError);
        cleanup();
        reject(new Error('Failed to insert YouTube API script into page'));
      }
    });
  }

  /**
   * Initialize YouTube player
   */
  async init(videoId, options = {}, retryCount = 0) {
    if (retryCount === 0) {
      this._initGeneration += 1;
      this._destroyed = false;
    }
    const generation = this._initGeneration;
    this.videoId = videoId;
    const MAX_INIT_RETRIES = 2;
    const assertActive = () => {
      if (this._isInitCancelled(generation)) throw this._createInitCancelledError();
    };

    try {
      // Wait for API to be ready
      if (!window.YT || !window.YT.Player) {
        console.log('[YouTube] Loading YouTube IFrame API...');
        await this.loadYouTubeAPI(0, generation);
      }
      assertActive();

      // Wait a bit for YT object to be fully initialized
      await new Promise(resolve => setTimeout(resolve, 100));
      assertActive();

      // Verify YT object is available
      if (!window.YT || !window.YT.Player) {
        throw new Error('YouTube API failed to initialize. YT.Player is not available.');
      }

      console.log(`[YouTube] Initializing player for video: ${videoId} (attempt ${retryCount + 1}/${MAX_INIT_RETRIES + 1})`);

      return new Promise((resolve, reject) => {
        let heartbeatInterval = null;
        let retryTimer = null;
        let initTimeout = null;
        let settled = false;

        const cleanup = () => {
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          if (retryTimer) clearTimeout(retryTimer);
          if (initTimeout) clearTimeout(initTimeout);
          heartbeatInterval = null;
          retryTimer = null;
          initTimeout = null;
          if (this._cancelInit === cancelInit) this._cancelInit = null;
        };
        const rejectOnce = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const resolveOnce = (value) => {
          if (settled) return;
          if (this._isInitCancelled(generation)) {
            rejectOnce(this._createInitCancelledError());
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        };
        const cancelInit = () => rejectOnce(this._createInitCancelledError());
        this._cancelInit = cancelInit;

        // Set a timeout for player initialization (increased from 15s to 30s)
        initTimeout = setTimeout(() => {
          if (this._isInitCancelled(generation)) {
            cancelInit();
            return;
          }
          console.error('[YouTube] Player initialization timeout. Debug info:', {
            hasPlayer: !!this.player,
            hasYT: !!window.YT,
            hasYTPlayer: !!(window.YT && window.YT.Player),
            videoId: videoId,
            containerId: this.containerId,
            retryCount: retryCount
          });

          // Clean up heartbeat interval
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
          }

          // Retry if we haven't exceeded max retries
          if (retryCount < MAX_INIT_RETRIES) {
            console.log('[YouTube] Retrying player initialization...');

            // Clean up failed player attempt
            if (this.player) {
              try {
                this.player.destroy();
              } catch (e) {
                console.warn('[YouTube] Error destroying failed player:', e);
              }
              this.player = null;
            }

            // Retry with exponential backoff
            retryTimer = setTimeout(() => {
              if (this._isInitCancelled(generation)) {
                cancelInit();
                return;
              }
              this.init(videoId, options, retryCount + 1)
                .then(resolveOnce)
                .catch(rejectOnce);
            }, 1000 * (retryCount + 1));
          } else {
            rejectOnce(new Error('YouTube player initialization timeout after multiple attempts. Please check your network connection or try refreshing the page.'));
          }
        }, 30000); // 30 seconds timeout (increased from 15s)

        try {
          // Verify container element exists
          const container = document.getElementById(this.containerId);
          if (!container) {
            rejectOnce(new Error(`Container element with id "${this.containerId}" not found`));
            return;
          }

          console.log('[YouTube] Creating player instance...', {
            containerId: this.containerId,
            videoId: videoId,
            containerExists: !!container,
            containerHTML: container.innerHTML.substring(0, 50)
          });

          // Heartbeat check: Sometimes the player works but onReady doesn't fire
          // Check periodically if player is functional
          let heartbeatCheckCount = 0;
          const MAX_HEARTBEAT_CHECKS = 60; // 60 checks * 500ms = 30 seconds

          heartbeatInterval = setInterval(() => {
            if (this._isInitCancelled(generation)) {
              cancelInit();
              return;
            }
            heartbeatCheckCount++;

            // Check if player exists and has basic methods
            if (this.player && this.player.getPlayerState) {
              try {
                const state = this.player.getPlayerState();
                // If we can get player state, the player is functional
                if (state !== undefined && state !== null) {
                  console.log('[YouTube] Player functional (detected via heartbeat), state:', state);

                  // Call the ready callback manually since it might not have fired
                  if (this.onReadyCallback) {
                    this.onReadyCallback({ target: this.player });
                  }
                  this.startTimeUpdateLoop();
                  resolveOnce(this.player);
                }
              } catch (e) {
                // Player not ready yet, continue checking
              }
            }

            // Stop checking after max attempts
            if (heartbeatCheckCount >= MAX_HEARTBEAT_CHECKS) {
              clearInterval(heartbeatInterval);
            }
          }, 500);

          this.player = new YT.Player(this.containerId, {
            videoId: videoId,
            playerVars: {
              autoplay: 0,
              controls: 1,
              disablekb: 0,
              enablejsapi: 1,
              fs: 1,
              modestbranding: 1,
              origin: getYouTubeOrigin(),
              rel: 0,
              // Keep YouTube's own CC off by default. Auto-captions wrap mid-sentence
              // ("…here" lands on the next line) and fight the video's on-screen lines
              // plus our caption / coaching dock. Re-enable only as a fallback when
              // clickable transcript segments cannot be fetched.
              cc_load_policy: 3,
              ...options.playerVars
            },
            events: {
              onReady: (event) => {
                if (this._isInitCancelled(generation)) {
                  cancelInit();
                  return;
                }
                console.log('[YouTube] Player ready event fired');
                this.disableNativeCaptions();
                if (this.onReadyCallback) {
                  this.onReadyCallback(event);
                }
                this.startTimeUpdateLoop();
                resolveOnce(this.player);
              },
              onApiChange: () => {
                if (this._isInitCancelled(generation)) return;
                // Captions module can load after ready and turn CC back on — keep it off
                // unless a caller explicitly asked for the native fallback.
                if (!this._nativeCaptionsWanted) this.disableNativeCaptions();
              },
              onStateChange: (event) => {
                if (this._isInitCancelled(generation)) return;
                if (this.onStateChangeCallback) {
                  this.onStateChangeCallback(event);
                }
                // Start/stop time update loop based on player state
                if (event.data === YT.PlayerState.PLAYING) {
                  this.startTimeUpdateLoop();
                } else if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
                  this.stopTimeUpdateLoop();
                }
              },
              onError: (event) => {
                if (this._isInitCancelled(generation)) {
                  cancelInit();
                  return;
                }
                console.error('[YouTube] Player error:', event.data);

                // Provide user-friendly error messages
                let errorMessage = 'YouTube player error';
                switch (event.data) {
                  case 2:
                    errorMessage = 'Invalid video ID or video not found';
                    break;
                  case 5:
                    errorMessage = 'HTML5 player error';
                    break;
                  case 100:
                    errorMessage = 'Video not found or has been removed';
                    break;
                  case 101:
                  case 150:
                    errorMessage = 'Video cannot be embedded or is restricted';
                    break;
                  default:
                    errorMessage = `YouTube player error: ${event.data}`;
                }

                rejectOnce(new Error(errorMessage));
              }
            }
          });
        } catch (error) {
          console.error('[YouTube] Failed to initialize player:', error);
          rejectOnce(new Error(`Failed to create YouTube player: ${error.message}`));
        }
      });
    } catch (error) {
      if (error && error.code !== 'YOUTUBE_INIT_CANCELLED') {
        console.error('[YouTube] Initialization failed:', error);
      }
      throw error;
    }
  }

  /**
   * Start time update loop (simulates timeupdate event)
   */
  startTimeUpdateLoop() {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
    }

    this.timeUpdateInterval = setInterval(() => {
      if (this.player && this.player.getCurrentTime) {
        const currentTime = this.player.getCurrentTime();
        if (this.onTimeUpdateCallback) {
          this.onTimeUpdateCallback(currentTime);
        }
      }
    }, 100); // Update every 100ms
  }

  /**
   * Stop time update loop
   */
  stopTimeUpdateLoop() {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
  }

  /**
   * Turn on YouTube's built-in caption track (visual fallback when
   * clickable transcript segments cannot be fetched).
   */
  enableNativeCaptions(languageCode = 'en') {
    if (!this.player) return false;
    this._nativeCaptionsWanted = true;
    try {
      if (typeof this.player.loadModule === 'function') {
        this.player.loadModule('captions');
      }
      if (typeof this.player.setOption === 'function') {
        this.player.setOption('captions', 'track', { languageCode: languageCode || 'en' });
      }
      return true;
    } catch (err) {
      console.warn('[YouTube] enableNativeCaptions failed:', err);
      return false;
    }
  }

  /**
   * Hide YouTube CC so it does not compete with baked-in video text or our dock.
   */
  disableNativeCaptions() {
    this._nativeCaptionsWanted = false;
    if (!this.player) return false;
    try {
      if (typeof this.player.setOption === 'function') {
        try { this.player.setOption('captions', 'track', {}); } catch (_) { }
        try { this.player.setOption('cc', 'track', {}); } catch (_) { }
      }
      if (typeof this.player.unloadModule === 'function') {
        try { this.player.unloadModule('captions'); } catch (_) { }
        try { this.player.unloadModule('cc'); } catch (_) { }
      }
      return true;
    } catch (err) {
      console.warn('[YouTube] disableNativeCaptions failed:', err);
      return false;
    }
  }

  /**
   * Play video
   */
  play() {
    if (this.player && this.player.playVideo) {
      this.player.playVideo();
    }
  }

  /**
   * Pause video
   */
  pause() {
    if (this.player && this.player.pauseVideo) {
      this.player.pauseVideo();
    }
  }

  /**
   * Seek to specific time
   */
  seekTo(seconds) {
    if (this.player && this.player.seekTo) {
      this.player.seekTo(seconds, true);
    }
  }

  /**
   * Get current time
   */
  getCurrentTime() {
    if (this.player && this.player.getCurrentTime) {
      return this.player.getCurrentTime();
    }
    return 0;
  }

  /**
   * Get duration
   */
  getDuration() {
    if (this.player && this.player.getDuration) {
      return this.player.getDuration();
    }
    return 0;
  }

  /**
   * Get player state
   */
  getPlayerState() {
    if (this.player && this.player.getPlayerState) {
      return this.player.getPlayerState();
    }
    return -1;
  }

  /**
   * Check if playing
   */
  isPlaying() {
    return this.getPlayerState() === YT.PlayerState.PLAYING;
  }

  isOverlaySuppressionActive() {
    return Date.now() < (this._suppressPauseOverlayUntil || 0);
  }

  /**
   * Best-effort: try to close YouTube's built-in pause overlay ("More videos") which lives inside the iframe.
   * We can't click the iframe UI due to cross-origin, so we "nudge" the player state.
   */
  suppressPauseOverlay() {
    try {
      if (!this.player) return;
      // Avoid loops: ignore state changes we trigger for a short window.
      this._suppressPauseOverlayUntil = Date.now() + 900;

      const p = this.player;
      const t = (typeof p.getCurrentTime === 'function') ? p.getCurrentTime() : null;
      const wasMuted = (typeof p.isMuted === 'function') ? !!p.isMuted() : false;

      if (!wasMuted && typeof p.mute === 'function') {
        try { p.mute(); } catch (_) { }
      }

      // A brief play -> pause often dismisses the pause overlay without needing to click the X.
      if (typeof p.playVideo === 'function') {
        try { p.playVideo(); } catch (_) { }
      } else if (typeof p.play === 'function') {
        try { p.play(); } catch (_) { }
      }

      setTimeout(() => {
        try {
          if (t != null && typeof p.seekTo === 'function') p.seekTo(t, true);
        } catch (_) { }
        try {
          if (typeof p.pauseVideo === 'function') p.pauseVideo();
          else if (typeof p.pause === 'function') p.pause();
        } catch (_) { }
        try {
          if (!wasMuted && typeof p.unMute === 'function') p.unMute();
        } catch (_) { }
      }, 80);
    } catch (_) { }
  }

  /**
   * Set volume (0-100)
   */
  setVolume(volume) {
    if (this.player && this.player.setVolume) {
      this.player.setVolume(volume);
    }
  }

  /**
   * Get volume
   */
  getVolume() {
    if (this.player && this.player.getVolume) {
      return this.player.getVolume();
    }
    return 100;
  }

  /**
   * Mute video
   */
  mute() {
    if (this.player && this.player.mute) {
      this.player.mute();
    }
  }

  /**
   * Unmute video
   */
  unMute() {
    if (this.player && this.player.unMute) {
      this.player.unMute();
    }
  }

  /**
   * Set playback rate
   */
  setPlaybackRate(rate) {
    if (this.player && this.player.setPlaybackRate) {
      this.player.setPlaybackRate(rate);
    }
  }

  /**
   * Get playback rate
   */
  getPlaybackRate() {
    if (this.player && this.player.getPlaybackRate) {
      return this.player.getPlaybackRate();
    }
    return 1;
  }

  /**
   * Register event callbacks
   */
  on(event, callback) {
    switch (event) {
      case 'ready':
        this.onReadyCallback = callback;
        break;
      case 'statechange':
        this.onStateChangeCallback = callback;
        break;
      case 'timeupdate':
        this.onTimeUpdateCallback = callback;
        break;
    }
  }

  /**
   * Destroy player
   */
  destroy() {
    this._destroyed = true;
    this._initGeneration += 1;
    if (this._cancelInit) {
      const cancel = this._cancelInit;
      this._cancelInit = null;
      try { cancel(); } catch (_) { }
    }
    this.stopTimeUpdateLoop();
    if (this.player && this.player.destroy) {
      try { this.player.destroy(); } catch (_) { }
    }
    this.player = null;
    this.ready = false;
    this.onReadyCallback = null;
    this.onStateChangeCallback = null;
    this.onTimeUpdateCallback = null;
  }
}

// Export for use in other modules / classic script pages
if (typeof globalThis !== 'undefined') globalThis.YouTubePlayer = YouTubePlayer;
if (typeof window !== 'undefined') window.YouTubePlayer = YouTubePlayer;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = YouTubePlayer;
}

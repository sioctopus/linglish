(function initPronunciationProfileUI(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LinglishPronunciationProfile = api;
    root.LinglishPronunciationProfileUI = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function createPronunciationProfileUI() {
  const EVIDENCE_LABELS = {
    provider_phoneme: '音素级测量',
    transcript_alignment: '词级测量',
    recording_signal: '节奏估算',
  };
  const FOCUS_TYPES = new Set(['missing_word', 'extra_word', 'phoneme', 'pace']);
  const FOCUS_TYPE_LABELS = {
    missing_word: '漏词清晰度',
    extra_word: '多余词与重复',
    phoneme: '音素发音',
    pace: '短语节奏',
  };
  const FOCUS_STATUS_LABELS = {
    focus: '优先练习',
    improving: '正在变好',
    stable: '已更稳定',
  };
  const TREND_DIRECTIONS = new Set(['collecting', 'up', 'down', 'flat']);
  const PROFILE_EVENT_NAMES = new Set([
    'pronunciation_profile_view',
    'pronunciation_focus_start',
    'pronunciation_skill_improved',
  ]);
  const improvedEventKeysByContainer = new WeakMap();

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function cleanText(value, maxLength = 240) {
    return typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
      : '';
  }

  function positiveId(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
    const normalized = value.replace(/^0+(?=\d)/, '');
    return normalized === '0' ? null : normalized;
  }

  function requestId(value) {
    const normalized = positiveId(value);
    if (!normalized) return null;
    try {
      return BigInt(normalized) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(normalized) : normalized;
    } catch (_) {
      return null;
    }
  }

  function positiveSequence(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function normalizeScore(value) {
    if (value === null) return null;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
      ? Math.round(value)
      : null;
  }

  function normalizeDimension(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const key = cleanText(value.key, 48);
    const label = cleanText(value.label, 80);
    if (!key || !label) return null;
    if (value.score !== null && (typeof value.score !== 'number' || !Number.isFinite(value.score))) return null;
    const evidence = Object.hasOwn(EVIDENCE_LABELS, value.evidence)
      ? value.evidence
      : 'transcript_alignment';
    return {
      key,
      label,
      score: normalizeScore(value.score),
      evidence,
    };
  }

  function normalizeFocusItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !FOCUS_TYPES.has(value.skill_type)) return undefined;
    const displayTarget = cleanText(value.display_target, 80);
    const videoId = positiveId(value.video_resource_id);
    const assessmentId = positiveId(value.assessment_id);
    if (!displayTarget) return undefined;
    if (!videoId || !assessmentId) {
      const hasMalformedId = (value.video_resource_id !== null && value.video_resource_id !== undefined && !videoId)
        || (value.assessment_id !== null && value.assessment_id !== undefined && !assessmentId);
      return hasMalformedId ? undefined : null;
    }
    const status = Object.hasOwn(FOCUS_STATUS_LABELS, value.status) ? value.status : 'focus';
    return {
      skill_type: value.skill_type,
      display_target: displayTarget,
      sample_text: cleanText(value.sample_text, 240),
      evidence_level: Object.hasOwn(EVIDENCE_LABELS, value.evidence_level)
        ? value.evidence_level
        : 'transcript_alignment',
      status,
      video_resource_id: videoId,
      assessment_id: assessmentId,
    };
  }

  function normalizeProfile(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Array.isArray(value.dimensions) || !Array.isArray(value.focus_items)) return null;
    if (value.status !== 'collecting' && value.status !== 'ready') return null;
    const sampleCount = value.sample_count;
    if (typeof sampleCount !== 'number' || !Number.isSafeInteger(sampleCount) || sampleCount < 0 || sampleCount > 20) return null;
    if ((value.status === 'collecting' && sampleCount >= 3) || (value.status === 'ready' && sampleCount < 3)) return null;
    const dimensions = value.dimensions.map(normalizeDimension);
    if (!dimensions.length || dimensions.some((dimension) => !dimension)) return null;
    const focusItems = value.focus_items.map(normalizeFocusItem);
    if (focusItems.some((item) => item === undefined)) return null;
    const trendDirection = TREND_DIRECTIONS.has(value.trend?.direction) ? value.trend.direction : 'collecting';
    return {
      status: value.status,
      sample_count: sampleCount,
      dimensions: dimensions.slice(0, 4),
      focus_items: focusItems.filter(Boolean).slice(0, 3),
      trend: { direction: trendDirection },
      disclaimer: cleanText(value.disclaimer, 300),
    };
  }

  function sampleBucket(sampleCount) {
    return sampleCount >= 3 ? '3_plus' : String(sampleCount);
  }

  function buildEventProperties(value) {
    const profile = normalizeProfile(value);
    if (!profile) return null;
    return {
      profile_status: profile.status,
      sample_bucket: sampleBucket(profile.sample_count),
      trend_direction: profile.trend.direction,
      focus_types: [...new Set(profile.focus_items.map((item) => item.skill_type))],
      focus_count: profile.focus_items.length,
    };
  }

  function sanitizeEventProperties(eventName, value) {
    if (!PROFILE_EVENT_NAMES.has(eventName) || !value || typeof value !== 'object') return null;
    if (eventName === 'pronunciation_skill_improved') {
      const skillTypes = Array.isArray(value.skill_types)
        ? [...new Set(value.skill_types.filter((type) => FOCUS_TYPES.has(type)))].slice(0, 3)
        : [];
      const evidenceLevels = Array.isArray(value.evidence_levels)
        ? [...new Set(value.evidence_levels.filter((level) => Object.hasOwn(EVIDENCE_LABELS, level)))].slice(0, 3)
        : [];
      const improvementCount = Number.isSafeInteger(value.improvement_count)
        && value.improvement_count > 0 && value.improvement_count <= 3
        ? value.improvement_count
        : null;
      if (!improvementCount || !skillTypes.length || !evidenceLevels.length) return null;
      return {
        improvement_count: improvementCount,
        skill_types: skillTypes,
        evidence_levels: evidenceLevels,
      };
    }
    const profileStatus = value.profile_status === 'ready' || value.profile_status === 'collecting'
      ? value.profile_status
      : null;
    const sampleBucket = ['0', '1', '2', '3_plus'].includes(value.sample_bucket)
      ? value.sample_bucket
      : null;
    const trendDirection = TREND_DIRECTIONS.has(value.trend_direction)
      ? value.trend_direction
      : null;
    const focusTypes = Array.isArray(value.focus_types)
      ? [...new Set(value.focus_types.filter((type) => FOCUS_TYPES.has(type)))].slice(0, 3)
      : [];
    const focusCount = Number.isSafeInteger(value.focus_count) && value.focus_count >= 0 && value.focus_count <= 3
      ? value.focus_count
      : focusTypes.length;
    if (!profileStatus || !sampleBucket || !trendDirection) return null;
    const properties = {
      profile_status: profileStatus,
      sample_bucket: sampleBucket,
      trend_direction: trendDirection,
      focus_types: focusTypes,
      focus_count: focusCount,
    };
    if (eventName === 'pronunciation_focus_start') {
      if (!FOCUS_TYPES.has(value.focus_type)) return null;
      properties.focus_type = value.focus_type;
    }
    return properties;
  }

  function createPronunciationEventTransport(options = {}) {
    const fetchImpl = options.fetch;
    const source = options.source === 'mobile_web' ? 'mobile_web' : 'web';
    return function emitPronunciationEvent(eventName, properties) {
      const safeProperties = sanitizeEventProperties(eventName, properties);
      if (!safeProperties || typeof fetchImpl !== 'function') return false;
      try {
        const token = typeof options.getToken === 'function' ? options.getToken() : null;
        if (!token) return false;
        const endpoint = typeof options.endpoint === 'function'
          ? options.endpoint(token)
          : options.endpoint;
        if (!endpoint) return false;
        const request = fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ event_name: eventName, properties: safeProperties, source }),
          keepalive: true,
        });
        if (request && typeof request.catch === 'function') request.catch(() => {});
        return true;
      } catch (_) {
        return false;
      }
    };
  }

  function safeFrom(value) {
    const from = cleanText(value, 64);
    return /^[a-z0-9_-]+$/i.test(from) ? from : 'pronunciation_map';
  }

  function buildFocusHref(item, { mobile = false, from = 'pronunciation_map' } = {}) {
    const videoId = positiveId(item?.video_resource_id);
    const assessmentId = positiveId(item?.assessment_id);
    if (!videoId || !assessmentId) return '';
    const page = mobile ? 'video-reader.html' : 'practice-session-desktop.html';
    return `${page}?videoId=${videoId}&focusAssessment=${assessmentId}&from=${encodeURIComponent(safeFrom(from))}`;
  }

  function buildPracticeHref({ mobile = false, from = 'pronunciation_map' } = {}) {
    const page = mobile ? 'video-reader.html' : 'practice-session-desktop.html';
    return `${page}?from=${encodeURIComponent(safeFrom(from))}`;
  }

  function buildPronunciationAssessmentPayload(options = {}) {
    const text = String(options.text || '').trim();
    const duration = Number(options.durationSeconds);
    const payload = {
      text,
      lemma: text.toLocaleLowerCase(),
      audio_data: options.audioData,
      duration_seconds: Number.isFinite(duration) ? duration : null,
    };
    const videoId = positiveId(options.videoId);
    if (videoId) payload.video_id = videoId;
    return payload;
  }

  function normalizeSkillUpdateItem(value) {
    if (!value || typeof value !== 'object' || !FOCUS_TYPES.has(value.type)) return null;
    const evidence = Object.hasOwn(EVIDENCE_LABELS, value.evidence) ? value.evidence : null;
    const status = Object.hasOwn(FOCUS_STATUS_LABELS, value.status) ? value.status : null;
    if (!evidence || !status) return null;
    return {
      type: value.type,
      evidence,
      status,
      display_target: cleanText(value.display_target, 80) || FOCUS_TYPE_LABELS[value.type],
    };
  }

  function normalizeSkillUpdate(value) {
    if (!value || typeof value !== 'object') return null;
    const improved = (Array.isArray(value.improved) ? value.improved : [])
      .map(normalizeSkillUpdateItem)
      .filter((item) => item && (item.status === 'improving' || item.status === 'stable'))
      .slice(0, 3);
    const needsFocus = (Array.isArray(value.needs_focus) ? value.needs_focus : [])
      .map(normalizeSkillUpdateItem)
      .filter((item) => item && item.status === 'focus')
      .slice(0, 3);
    if (!improved.length && !needsFocus.length) return null;
    return { improved, needs_focus: needsFocus };
  }

  function skillUpdateSummary(update) {
    const parts = [];
    if (update.improved.length) parts.push(`本次已改善：${update.improved.map((item) => item.display_target).join('、')}`);
    if (update.needs_focus.length) parts.push(`继续关注：${update.needs_focus.map((item) => item.display_target).join('、')}`);
    return cleanText(parts.join(' · '), 220);
  }

  function directSkillUpdateHost(container) {
    if (!container?.children || typeof container.children.length !== 'number') return null;
    for (let index = 0; index < container.children.length; index += 1) {
      const child = container.children[index];
      if (child?.getAttribute?.('data-pronunciation-skill-update') === 'true') return child;
    }
    return null;
  }

  function consumeSkillUpdate(container, value, options = {}) {
    if (!container) return false;
    const staleHost = directSkillUpdateHost(container);
    const update = normalizeSkillUpdate(value);
    if (!update) {
      staleHost?.remove?.();
      return false;
    }
    const documentObject = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!documentObject?.createElement) return false;
    let host = directSkillUpdateHost(container);
    if (!host) {
      host = documentObject.createElement('p');
      host.className = 'pronunciation-skill-update';
      host.setAttribute('data-pronunciation-skill-update', 'true');
      const beforeNode = options.beforeNode;
      if (beforeNode?.parentNode === container && typeof container.insertBefore === 'function') {
        container.insertBefore(host, beforeNode);
      } else if (typeof container.appendChild === 'function') {
        container.appendChild(host);
      } else {
        return false;
      }
    }
    host.textContent = skillUpdateSummary(update);
    const eventKey = cleanText(options.eventKey, 120) || 'default';
    let improvedEventKeys = improvedEventKeysByContainer.get(container);
    if (!improvedEventKeys) {
      improvedEventKeys = new Set();
      improvedEventKeysByContainer.set(container, improvedEventKeys);
    }
    if (update.improved.length && !improvedEventKeys.has(eventKey)) {
      improvedEventKeys.add(eventKey);
      notify(options, 'pronunciation_skill_improved', {
        improvement_count: update.improved.length,
        skill_types: [...new Set(update.improved.map((item) => item.type))],
        evidence_levels: [...new Set(update.improved.map((item) => item.evidence))],
      });
    }
    return true;
  }

  function buildCoachSpeechFocus(value, fallback) {
    const profile = normalizeProfile(value);
    const focus = profile?.focus_items?.[0];
    return focus ? cleanText(`今日重点：${focusTitle(focus)}`, 120) : cleanText(fallback, 120);
  }

  function evidenceTag(evidence) {
    return EVIDENCE_LABELS[evidence] || EVIDENCE_LABELS.transcript_alignment;
  }

  function focusTitle(item) {
    if (item.skill_type === 'phoneme') return `把 /${item.display_target}/ 练得更稳`;
    if (item.skill_type === 'pace') return '把这一句的节奏练顺';
    if (item.skill_type === 'extra_word') return '减少多余词和重复';
    return `先把 “${item.display_target}” 说清楚`;
  }

  function buildLaneMarkup(dimension, ready) {
    const unavailable = dimension.score === null;
    const valueMarkup = !ready
      ? '<span class="pronunciation-profile-lane-state">正在收集</span>'
      : unavailable
        ? `<span class="pronunciation-profile-lane-state">${dimension.key === 'phoneme' ? '暂无音素级证据' : '暂无足够证据'}</span>`
        : `<span class="pronunciation-profile-lane-score">${dimension.score}</span>`;
    const meterMarkup = ready && !unavailable
      ? `<span class="pronunciation-profile-lane-meter" aria-hidden="true"><span class="pronunciation-profile-lane-fill" style="width:${dimension.score}%"></span></span>`
      : '';
    return `<li class="pronunciation-profile-lane" data-dimension="${escapeHtml(dimension.key)}">
      <div class="pronunciation-profile-lane-label"><span>${escapeHtml(dimension.label)}</span><small>${escapeHtml(evidenceTag(dimension.evidence))}</small></div>
      <div class="pronunciation-profile-lane-value">${valueMarkup}</div>
      ${meterMarkup}
    </li>`;
  }

  function buildMarkup(value, options = {}) {
    const profile = normalizeProfile(value);
    if (!profile) return '';
    const ready = profile.status === 'ready';
    const remaining = Math.max(0, 3 - profile.sample_count);
    const focus = profile.focus_items[0] || null;
    const href = focus ? buildFocusHref(focus, options) : '';
    const focusMarkup = focus
      ? `<article class="pronunciation-profile-focus" data-focus-type="${escapeHtml(focus.skill_type)}">
          <div class="pronunciation-profile-focus-note">本轮练习重点 <span>${escapeHtml(FOCUS_TYPE_LABELS[focus.skill_type])} · ${escapeHtml(evidenceTag(focus.evidence_level))} · ${escapeHtml(FOCUS_STATUS_LABELS[focus.status])}</span></div>
          <h3>${escapeHtml(focusTitle(focus))}</h3>
          ${focus.sample_text ? `<p>来自：${escapeHtml(focus.sample_text)}</p>` : ''}
          ${href ? `<a class="pronunciation-profile-focus-cta" data-pronunciation-focus-cta="true" href="${escapeHtml(href)}">课后弱点练习 <span aria-hidden="true">→</span></a>` : ''}
        </article>`
      : `<article class="pronunciation-profile-focus pronunciation-profile-focus--quiet">
          <div class="pronunciation-profile-focus-note">下一步</div>
          <h3>${ready ? '继续保持这份清晰感' : '完成下一次可信练习'}</h3>
          <p>${ready ? '新的练习会让这份观察更贴近你的现在。' : '录完后，我们会把观察补成一张更完整的地图。'}</p>
          <a class="pronunciation-profile-focus-cta" href="${escapeHtml(buildPracticeHref(options))}">去视频跟读 <span aria-hidden="true">→</span></a>
        </article>`;
    const statusMarkup = ready
      ? '<p class="pronunciation-profile-summary">跟读留下的弱点会收在这里。先练一件事，练完再回来看变化。</p>'
      : `<p class="pronunciation-profile-summary">还差 ${remaining} 次可信练习，才会攒出可练的弱点清单。</p>`;

    return `<section class="pronunciation-profile-card" aria-labelledby="pronunciation-profile-title">
      <header class="pronunciation-profile-header">
        <p class="pronunciation-profile-kicker">课后弱点练习</p>
        <span class="pronunciation-profile-status" data-status="${profile.status}">${ready ? '可练' : '收集中'}</span>
        <h2 id="pronunciation-profile-title">${ready ? '先练最需要补的一点' : '先跟读三次，攒弱点'}</h2>
        ${statusMarkup}
      </header>
      ${focusMarkup}
      <section class="pronunciation-profile-lanes" aria-labelledby="pronunciation-profile-lanes-title">
        <div class="pronunciation-profile-section-heading">
          <h3 id="pronunciation-profile-lanes-title">能力线索</h3>
          <span>${ready ? '已测量与估算' : `已收集 ${profile.sample_count} / 3`}</span>
        </div>
        <ul>${profile.dimensions.map((dimension) => buildLaneMarkup(dimension, ready)).join('')}</ul>
      </section>
      ${profile.disclaimer ? `<p class="pronunciation-profile-disclaimer">${escapeHtml(profile.disclaimer)}</p>` : ''}
    </section>`;
  }

  function profileFingerprint(properties) {
    return [
      properties.profile_status,
      properties.sample_bucket,
      properties.trend_direction,
      properties.focus_types.join(','),
    ].join('|');
  }

  function directProfileHost(container) {
    if (!container || !container.children || typeof container.children.length !== 'number') return null;
    for (let index = 0; index < container.children.length; index += 1) {
      const child = container.children[index];
      if (child && typeof child.getAttribute === 'function'
        && child.getAttribute('data-pronunciation-profile-host') === 'true') return child;
    }
    return null;
  }

  function notify(options, name, properties) {
    try {
      if (typeof options.emit === 'function') options.emit(name, properties);
    } catch (_) {
      // Analytics is optional; rendering and navigation stay available.
    }
    try {
      if (typeof options.dispatch === 'function') options.dispatch('linglish:pronunciation-profile', properties);
    } catch (_) {
      // Consumers may be absent while the standalone component remains usable.
    }
  }

  function bindFocusAction(host, profile, options) {
    const cta = typeof host.querySelector === 'function'
      ? host.querySelector('[data-pronunciation-focus-cta]')
      : null;
    if (!cta || typeof cta.addEventListener !== 'function') return;
    const focus = profile.focus_items[0];
    cta.addEventListener('click', () => {
      const properties = { ...buildEventProperties(profile), focus_type: focus.skill_type };
      notify(options, 'pronunciation_focus_start', properties);
    });
  }

  function mount(container, value, options = {}) {
    const profile = normalizeProfile(value);
    if (!container || !profile) return false;
    const markup = buildMarkup(profile, options);
    if (!markup) return false;

    let host = null;
    try {
      const documentObject = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (!documentObject || typeof documentObject.createElement !== 'function') return false;
      const existing = directProfileHost(container);
      if (existing && typeof existing.remove !== 'function') return false;
      host = documentObject.createElement('div');
      host.className = 'pronunciation-profile-host';
      host.setAttribute('data-pronunciation-profile-host', 'true');
      host.innerHTML = markup;

      const beforeNode = options.beforeNode;
      if (beforeNode && beforeNode.parentNode === container && typeof container.insertBefore === 'function') {
        container.insertBefore(host, beforeNode);
      } else if (typeof container.appendChild === 'function') {
        container.appendChild(host);
      } else {
        return false;
      }
      if (existing && existing !== host && typeof existing.remove === 'function') existing.remove();
      bindFocusAction(host, profile, options);

      const properties = buildEventProperties(profile);
      const fingerprint = profileFingerprint(properties);
      const dataset = container.dataset || (container.dataset = {});
      if (dataset.pronunciationProfileImpression !== fingerprint) {
        dataset.pronunciationProfileImpression = fingerprint;
        notify(options, 'pronunciation_profile_view', properties);
      }
      return true;
    } catch (_) {
      if (host && typeof host.remove === 'function') host.remove();
      return false;
    }
  }

  function clear(container) {
    const existing = directProfileHost(container);
    if (!existing || typeof existing.remove !== 'function') return false;
    existing.remove();
    return true;
  }

  function tokens(value) {
    return (cleanText(value, 500).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  }

  function locateFocusSegment(segments, focusText) {
    const target = [...new Set(tokens(focusText))];
    if (!target.length || !Array.isArray(segments)) return null;
    let best = null;
    let bestRawScore = -1;
    segments.forEach((segment, arrayIndex) => {
      if (!segment || typeof segment !== 'object') return;
      const segmentTokens = new Set(tokens(segment.text));
      const overlap = target.filter((token) => segmentTokens.has(token)).length / target.length;
      if (overlap >= 0.6 && overlap > bestRawScore) {
        bestRawScore = overlap;
        best = {
          index: segment.index != null ? segment.index : arrayIndex,
          score: Number(overlap.toFixed(2)),
        };
      }
    });
    return best;
  }

  async function loadProfileSection(options = {}) {
    const section = options.section;
    const container = options.container || section;
    const hide = () => {
      clear(container);
      if (section) section.hidden = true;
      return null;
    };
    if (!options.authenticated || !section || !container || typeof options.request !== 'function') {
      return hide();
    }

    try {
      const value = await options.request();
      const profile = normalizeProfile(value);
      if (!profile || !mount(container, profile, {
        mobile: options.mobile === true,
        from: options.from || 'pronunciation_map',
        emit: options.emit,
        dispatch: options.dispatch,
      })) return hide();
      if (container.children && typeof container.children.length === 'number') {
        for (let index = container.children.length - 1; index >= 0; index -= 1) {
          const child = container.children[index];
          if (child?.getAttribute?.('data-pronunciation-profile-loading') === 'true') child.remove?.();
        }
      }
      section.hidden = false;
      return profile;
    } catch (_) {
      return hide();
    }
  }

  function isTemporaryProfileUser(user) {
    if (!user || typeof user !== 'object') return true;
    const email = cleanText(user.email, 160).toLocaleLowerCase();
    if (email.startsWith('guest_') && email.endsWith('@temp.linglish.local')) return true;
    return user.is_guest === true || user.isGuest === true || Boolean(user.guest_id || user.guestId);
  }

  function createTodayProfileController(options = {}) {
    return {
      load(user) {
        return loadProfileSection({
          authenticated: !isTemporaryProfileUser(user),
          section: options.section,
          container: options.container,
          mobile: options.mobile === true,
          from: 'pronunciation_map',
          request: options.requestProfile,
          emit: options.emit,
          dispatch: options.dispatch,
        });
      },
    };
  }

  function focusAssessmentId(value) {
    return requestId(value);
  }

  function createFocusController(options = {}) {
    const assessmentId = focusAssessmentId(options.assessmentId);
    let transcriptReady = false;
    let playerReady = false;
    let attempt = null;

    function result(status, extra = {}) {
      return { status, ...extra };
    }

    function reportUnavailable() {
      try {
        if (typeof options.feedback === 'function') {
          options.feedback('暂时无法定位发音重点，你仍可正常练习', 'info');
        }
      } catch (_) {
        // Focus feedback must never block the underlying video or practice flow.
      }
      return result('unavailable');
    }

    async function applyWhenReady() {
      if (!assessmentId) return result('ignored');
      if (!transcriptReady || !playerReady) return result('waiting');
      if (attempt) return attempt;
      attempt = (async () => {
        try {
          if (typeof options.fetchFocus !== 'function'
            || typeof options.getLoadedVideoId !== 'function'
            || typeof options.getSegments !== 'function') return reportUnavailable();
          const segments = options.getSegments();
          if (!Array.isArray(segments) || !segments.length) return reportUnavailable();
          const focus = await options.fetchFocus(assessmentId);
          const loadedVideoId = positiveId(options.getLoadedVideoId());
          const focusVideoId = positiveId(focus?.video_resource_id);
          if (!loadedVideoId || !focusVideoId || loadedVideoId !== focusVideoId) return reportUnavailable();
          const match = locateFocusSegment(segments, focus?.text);
          if (!match) return reportUnavailable();
          const arrayIndex = segments.findIndex((segment, index) => {
            const segmentIndex = segment?.index != null ? segment.index : index;
            return segmentIndex === match.index;
          });
          if (arrayIndex < 0) return reportUnavailable();
          const segment = segments[arrayIndex];
          const start = Number(segment?.start ?? segment?.start_sec);
          if (!Number.isFinite(start)) return reportUnavailable();
          const position = {
            arrayIndex,
            segmentIndex: match.index,
            score: match.score,
            seekTime: Math.max(0, Number((start - 0.2).toFixed(3))),
            segment,
          };
          if (typeof options.apply !== 'function') return reportUnavailable();
          options.apply(position);
          try {
            if (typeof options.feedback === 'function') {
              options.feedback('已定位到你的发音重点', 'success');
            }
          } catch (_) {
            // Positioning succeeded; optional feedback may still be unavailable.
          }
          return result('applied', { position });
        } catch (_) {
          return reportUnavailable();
        }
      })();
      return attempt;
    }

    return {
      markPlayerReady() {
        playerReady = true;
        return applyWhenReady();
      },
      markTranscriptReady() {
        transcriptReady = true;
        return applyWhenReady();
      },
    };
  }

  function createVideoFocusController(options = {}) {
    const assessmentId = focusAssessmentId(options.assessmentId);
    const targetVideoId = positiveId(options.targetVideoId);
    let generationCounter = 0;
    let current = null;

    function createContextAbortController() {
      try {
        if (typeof options.createAbortController === 'function') return options.createAbortController();
        if (typeof AbortController === 'function') return new AbortController();
      } catch (_) {
        // Older browsers may not expose AbortController; logical cancellation still applies.
      }
      return null;
    }

    function result(status, extra = {}) {
      return { status, ...extra };
    }

    function matchesCurrent(context) {
      return Boolean(context && current === context
        && current.generation === context.generation
        && current.videoId === context.videoId);
    }

    function currentVideoMatchesTarget(context) {
      const loadedVideoId = typeof options.getCurrentVideoId === 'function'
        ? positiveId(options.getCurrentVideoId())
        : null;
      return matchesCurrent(context)
        && context.videoId === targetVideoId
        && loadedVideoId === targetVideoId;
    }

    function reportUnavailable(context) {
      if (!matchesCurrent(context)) return result('cancelled');
      try {
        if (typeof options.feedback === 'function') {
          options.feedback('暂时无法定位发音重点，你仍可正常练习', 'info');
        }
      } catch (_) {
        // Focus feedback remains optional and non-blocking.
      }
      return result('unavailable');
    }

    async function applyWhenReady(context) {
      if (!assessmentId || !targetVideoId) return result('ignored');
      if (!matchesCurrent(context)) return result('cancelled');
      if (context.videoId !== targetVideoId) return result('ignored');
      if (!context.transcriptReady || !context.playerReady) return result('waiting');
      if (context.attempt) return context.attempt;
      context.attempt = (async () => {
        try {
          if (!currentVideoMatchesTarget(context) || typeof options.fetchFocus !== 'function') {
            return reportUnavailable(context);
          }
          const focus = await options.fetchFocus(assessmentId, context.abortController?.signal);
          if (!currentVideoMatchesTarget(context)) return result('cancelled');
          const focusVideoId = positiveId(focus?.video_resource_id);
          if (focusVideoId !== targetVideoId) return reportUnavailable(context);
          const segments = typeof options.getSegments === 'function' ? options.getSegments() : null;
          if (!Array.isArray(segments) || !segments.length) return reportUnavailable(context);
          const match = locateFocusSegment(segments, focus?.text);
          if (!match || !currentVideoMatchesTarget(context)) return reportUnavailable(context);
          const arrayIndex = segments.findIndex((segment, index) => {
            const segmentIndex = segment?.index != null ? segment.index : index;
            return segmentIndex === match.index;
          });
          if (arrayIndex < 0) return reportUnavailable(context);
          const segment = segments[arrayIndex];
          const start = Number(segment?.start ?? segment?.start_sec);
          if (!Number.isFinite(start)) return reportUnavailable(context);
          const seekTime = Math.max(0, Number((start - 0.2).toFixed(3)));
          if (!currentVideoMatchesTarget(context)
            || typeof options.seek !== 'function'
            || typeof options.highlight !== 'function') return reportUnavailable(context);
          options.seek(seekTime);
          options.highlight({
            arrayIndex,
            segmentIndex: match.index,
            score: match.score,
            segment,
          });
          try {
            if (typeof options.feedback === 'function') {
              options.feedback('已定位到你的发音重点', 'success');
            }
          } catch (_) {
            // Positioning has already succeeded.
          }
          return result('applied', { arrayIndex, segmentIndex: match.index, seekTime });
        } catch (error) {
          if (!matchesCurrent(context)
            || context.abortController?.signal?.aborted
            || error?.name === 'AbortError') return result('cancelled');
          return reportUnavailable(context);
        }
      })();
      return context.attempt;
    }

    async function markReady(kind, signal = {}) {
      const videoId = positiveId(signal.videoId);
      const generation = positiveSequence(signal.generation);
      if (!current || videoId !== current.videoId || generation !== current.generation) {
        return result('cancelled');
      }
      const context = current;
      if (kind === 'transcript' && signal.prepare && typeof signal.prepare.then === 'function') {
        try { await signal.prepare; } catch (_) { /* Preparation completed with fallback transcript. */ }
        if (!matchesCurrent(context)) return result('cancelled');
      }
      if (kind === 'transcript') context.transcriptReady = true;
      if (kind === 'player') context.playerReady = true;
      return applyWhenReady(context);
    }

    return {
      selectVideo(videoId, generation) {
        if (current?.abortController && !current.abortController.signal?.aborted) {
          try { current.abortController.abort(); } catch (_) { }
        }
        const suppliedGeneration = positiveSequence(generation);
        generationCounter = suppliedGeneration || (generationCounter + 1);
        current = {
          generation: generationCounter,
          videoId: positiveId(videoId),
          transcriptReady: false,
          playerReady: false,
          attempt: null,
          abortController: createContextAbortController(),
        };
        return generationCounter;
      },
      markPlayerReady(signal) {
        return markReady('player', signal);
      },
      markTranscriptReady(signal) {
        return markReady('transcript', signal);
      },
    };
  }

  function createVideoReaderSelectionAdapter(options = {}) {
    let generation = 0;
    let current = null;
    const disposed = new WeakSet();

    function safeDestroy(disposable) {
      try {
        if (!disposable || (typeof disposable !== 'object' && typeof disposable !== 'function')) return;
        if (disposed.has(disposable)) return;
        disposed.add(disposable);
        if (typeof disposable.destroy === 'function') disposable.destroy();
      } catch (_) {
        // Stale resources must not block the next selection.
      }
    }

    function disposeContext(context) {
      if (!context) return;
      context.disposables.forEach(safeDestroy);
      context.disposables.clear();
      context.cleanups.forEach((cleanup) => {
        try { cleanup(); } catch (_) { }
      });
      context.cleanups.clear();
    }

    function publicSelection(context) {
      return { videoId: context.videoId, generation: context.generation };
    }

    function isCurrent(selection) {
      const videoId = focusAssessmentId(selection?.videoId);
      const selectionGeneration = focusAssessmentId(selection?.generation);
      return Boolean(current
        && videoId === current.videoId
        && selectionGeneration === current.generation);
    }

    function resultOf(effect) {
      const value = effect();
      return value === undefined ? true : value;
    }

    return {
      select(videoId) {
        const previous = current;
        current = null;
        disposeContext(previous);
        generation += 1;
        current = {
          videoId: focusAssessmentId(videoId),
          generation,
          disposables: new Set(),
          cleanups: new Set(),
        };
        const selection = publicSelection(current);
        try {
          if (typeof options.onSelect === 'function') options.onSelect(selection);
        } catch (_) {
          // Selection remains usable when an optional consumer is absent.
        }
        return selection;
      },
      isCurrent,
      currentSelection() {
        return current ? publicSelection(current) : null;
      },
      commit(selection, effect) {
        if (!isCurrent(selection) || typeof effect !== 'function') return false;
        return resultOf(effect);
      },
      trackDisposable(selection, disposable) {
        if (!isCurrent(selection)) {
          safeDestroy(disposable);
          return false;
        }
        current.disposables.add(disposable);
        return true;
      },
      activateDisposable(selection, disposable, activate) {
        if (!isCurrent(selection)) {
          safeDestroy(disposable);
          return false;
        }
        current.disposables.add(disposable);
        if (typeof activate !== 'function') return true;
        return resultOf(activate);
      },
      discardDisposable(selection, disposable) {
        const matches = isCurrent(selection);
        if (matches) current.disposables.delete(disposable);
        safeDestroy(disposable);
        return matches;
      },
      onDispose(selection, cleanup) {
        if (!isCurrent(selection) || typeof cleanup !== 'function') {
          try { if (typeof cleanup === 'function') cleanup(); } catch (_) { }
          return false;
        }
        current.cleanups.add(cleanup);
        return true;
      },
    };
  }

  function createVideoReaderRequestTracker(options = {}) {
    const selectionAdapter = options.selectionAdapter;
    const store = options.store instanceof Set ? options.store : new Set();
    const active = new Map();

    function settle(token) {
      if (!token || active.get(token.key) !== token) return false;
      active.delete(token.key);
      store.delete(token.key);
      return true;
    }

    function begin(selection, requestName) {
      if (!selectionAdapter?.isCurrent(selection)) return null;
      const name = cleanText(requestName, 64);
      if (!name) return null;
      const key = `${selection.videoId}:${selection.generation}:${name}`;
      if (store.has(key)) return null;
      const token = { key };
      store.add(key);
      active.set(key, token);
      selectionAdapter.onDispose(selection, () => settle(token));
      return token;
    }

    return {
      begin,
      run(selection, requestName, request) {
        if (typeof request !== 'function') return null;
        const token = begin(selection, requestName);
        if (!token) return null;
        try {
          return Promise.resolve(request()).finally(() => settle(token));
        } catch (error) {
          settle(token);
          return Promise.reject(error);
        }
      },
      settle,
      size() {
        return store.size;
      },
    };
  }

  function discardVideoReaderInitFailure(options = {}) {
    const selectionAdapter = options.selectionAdapter;
    if (options.error?.code === 'YOUTUBE_INIT_CANCELLED'
      || !selectionAdapter?.isCurrent(options.selection)) return false;
    return selectionAdapter.discardDisposable(options.selection, options.disposable);
  }

  function createSmartImportSessionCoordinator(options = {}) {
    const selectionAdapter = options.selectionAdapter;
    const ownedLifecycles = new Map();
    let currentLifecycle = null;
    let lifecycleVersion = 0;

    function createLifecycleKey() {
      if (typeof options.createLifecycleKey === 'function') return options.createLifecycleKey();
      const cryptoObject = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
      if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID();
      const bytes = new Uint8Array(16);
      if (typeof cryptoObject?.getRandomValues === 'function') cryptoObject.getRandomValues(bytes);
      else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    }

    function sameSelection(lifecycle, selection) {
      return Boolean(lifecycle
        && lifecycle.selection.videoId === selection?.videoId
        && lifecycle.selection.generation === selection?.generation);
    }

    function releaseLifecycle(lifecycle) {
      ownedLifecycles.delete(lifecycle.lifecycleKey);
      if (currentLifecycle === lifecycle) currentLifecycle = null;
    }

    async function closeLifecycle(lifecycle, close = options.closeLifecycle, abandonSession = options.abandonSession) {
      if (!lifecycle || lifecycle.closed) return true;
      if (lifecycle.closePromise) return lifecycle.closePromise;
      const operation = (async () => {
        try {
          let closed = false;
          if (typeof close === 'function') {
            closed = await close({
              lifecycleKey: lifecycle.lifecycleKey,
              videoId: lifecycle.selection.videoId,
              sessionId: lifecycle.result?.sessionId || null,
            }) !== false;
          } else if (lifecycle.result?.sessionId && typeof abandonSession === 'function') {
            closed = await abandonSession(lifecycle.result.sessionId) !== false;
          }
          if (!closed) return false;
          lifecycle.closed = true;
          releaseLifecycle(lifecycle);
          return true;
        } catch (error) {
          if (typeof options.onError === 'function') options.onError(error, 'abandon');
          return false;
        }
      })();
      lifecycle.closePromise = operation;
      try {
        return await operation;
      } finally {
        if (lifecycle.closePromise === operation) lifecycle.closePromise = null;
      }
    }

    async function closeOwnedLifecycles(close, abandonSession, except = null) {
      const lifecycles = [...ownedLifecycles.values()].filter((lifecycle) => lifecycle !== except);
      const results = await Promise.all(lifecycles.map((lifecycle) => (
        closeLifecycle(lifecycle, close, abandonSession)
      )));
      return results.every(Boolean);
    }

    function ownLifecycle(selection) {
      if (sameSelection(currentLifecycle, selection) && !currentLifecycle.closed) return currentLifecycle;
      const lifecycle = {
        selection,
        lifecycleKey: createLifecycleKey(),
        result: null,
        state: 'pending',
        startPromise: null,
        closePromise: null,
        closed: false,
      };
      ownedLifecycles.set(lifecycle.lifecycleKey, lifecycle);
      currentLifecycle = lifecycle;
      return lifecycle;
    }

    function start(selection, expectedVersion = lifecycleVersion) {
      if (!selectionAdapter?.isCurrent(selection) || typeof options.startSession !== 'function') {
        return Promise.resolve({ status: 'discarded' });
      }
      const lifecycle = ownLifecycle(selection);
      if (lifecycle.startPromise) return lifecycle.startPromise;
      for (const previous of ownedLifecycles.values()) {
        if (previous !== lifecycle) closeLifecycle(previous);
      }
      const operation = (async () => {
        try {
          const result = await options.startSession(selection.videoId, lifecycle.lifecycleKey);
          if (result?.sessionId) lifecycle.result = result;
          if (lifecycle.closed) return { status: 'discarded' };
          if (!result?.sessionId) throw new Error('SmartImport start returned no sessionId');
          if (result.status && result.status !== 'active') {
            lifecycle.closed = true;
            releaseLifecycle(lifecycle);
            return { status: 'discarded' };
          }
          if (!selectionAdapter.isCurrent(selection) || expectedVersion !== lifecycleVersion) {
            await closeLifecycle(lifecycle);
            return { status: 'discarded' };
          }
          lifecycle.state = 'active';
          currentLifecycle = lifecycle;
          if (typeof options.onSession === 'function') options.onSession(result, selection);
          return { status: 'active', result };
        } catch (error) {
          if (!lifecycle.closed
            && selectionAdapter.isCurrent(selection)
            && expectedVersion === lifecycleVersion
            && typeof options.onError === 'function') {
            options.onError(error, 'start');
          }
          return {
            status: lifecycle.closed
              || !selectionAdapter.isCurrent(selection)
              || expectedVersion !== lifecycleVersion
              ? 'discarded'
              : 'failed',
            error,
          };
        } finally {
          lifecycle.startPromise = null;
        }
      })();
      lifecycle.startPromise = operation;
      return operation;
    }

    return {
      start,
      async transition(selection, state = {}) {
        lifecycleVersion += 1;
        const expectedVersion = lifecycleVersion;
        try {
          if (typeof options.onReset === 'function') options.onReset(selection, { ready: state.ready === true });
        } catch (_) {
          // Page state reset is best-effort; session ownership still advances.
        }
        const reusable = sameSelection(currentLifecycle, selection) && state.ready === true
          ? currentLifecycle
          : null;
        if (ownedLifecycles.size > (reusable ? 1 : 0)) {
          await closeOwnedLifecycles(options.closeLifecycle, options.abandonSession, reusable);
        }
        if (!selectionAdapter?.isCurrent(selection) || expectedVersion !== lifecycleVersion) {
          return { status: 'discarded' };
        }
        if (state.ready !== true) return { status: 'inactive' };
        return start(selection, expectedVersion);
      },
      async dispose(disposeOptions = {}) {
        lifecycleVersion += 1;
        if (!ownedLifecycles.size) return { status: 'inactive' };
        const closed = await closeOwnedLifecycles(
          disposeOptions.closeLifecycle || options.closeLifecycle,
          disposeOptions.abandonSession || options.abandonSession,
        );
        return { status: closed ? 'abandoned' : 'failed' };
      },
      async finish(selection, watchedSegments, watchDurationSec) {
        const session = currentLifecycle;
        if (!session || session.state !== 'active'
          || !selectionAdapter?.isCurrent(selection)
          || session.selection.generation !== selection.generation
          || typeof options.finishSession !== 'function') {
          return { status: 'discarded' };
        }
        try {
          const result = await options.finishSession(
            session.result.sessionId,
            watchedSegments,
            watchDurationSec,
            session.lifecycleKey,
          );
          if (selectionAdapter.isCurrent(selection) && typeof options.onFinish === 'function') {
            options.onFinish(result, selection);
          }
          session.closed = true;
          releaseLifecycle(session);
          return { status: 'finished', result };
        } catch (error) {
          if (typeof options.onError === 'function') options.onError(error, 'finish');
          return { status: 'failed', error };
        }
      },
      getActiveSessionId() {
        return currentLifecycle?.state === 'active' ? currentLifecycle.result?.sessionId || null : null;
      },
    };
  }

  function createVideoReaderSpeakerCoordinator(options = {}) {
    const selectionAdapter = options.selectionAdapter;
    const getCurrentSelection = typeof options.getCurrentSelection === 'function'
      ? options.getCurrentSelection
      : () => selectionAdapter?.currentSelection?.();

    async function refreshSelection(videoId, selection) {
      if (!selection || selection.videoId !== videoId || typeof options.refresh !== 'function') {
        return { status: 'video_changed' };
      }
      await options.refresh(videoId, selection);
      return {
        status: selectionAdapter?.isCurrent(selection) ? 'refreshed' : 'stale',
      };
    }

    return {
      async refreshCurrent(videoId) {
        return refreshSelection(videoId, getCurrentSelection());
      },
      async writeThenRefresh(videoId, write) {
        if (typeof write !== 'function') return { status: 'failed' };
        await write();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const selection = getCurrentSelection();
          if (!selection || selection.videoId !== videoId) return { status: 'video_changed' };
          const result = await refreshSelection(videoId, selection);
          if (result.status === 'refreshed') return result;
        }
        return { status: 'stale' };
      },
    };
  }

  return {
    buildCoachSpeechFocus,
    buildEventProperties,
    buildFocusHref,
    buildMarkup,
    buildPronunciationAssessmentPayload,
    clear,
    consumeSkillUpdate,
    createFocusController,
    createPronunciationEventTransport,
    createTodayProfileController,
    createVideoFocusController,
    createSmartImportSessionCoordinator,
    createVideoReaderRequestTracker,
    createVideoReaderSelectionAdapter,
    createVideoReaderSpeakerCoordinator,
    discardVideoReaderInitFailure,
    loadProfileSection,
    locateFocusSegment,
    mount,
    normalizeProfile,
  };
});

(function (global) {
  var KEY = 'linglish_tts_voice';
  var ACCENT_KEY = 'linglish_daily_accent';
  // Prefer Conversation / podcast-like Edge voices over News-style ones.
  var VOICES = [
    { voice: 'en-US-AvaMultilingualNeural', name: 'Ava', accent: '美式', gender: '女声', tone: '播客聊天' },
    { voice: 'en-US-AndrewMultilingualNeural', name: 'Andrew', accent: '美式', gender: '男声', tone: '播客主持' },
    { voice: 'en-US-JennyNeural', name: 'Jenny', accent: '美式', gender: '女声', tone: '温和讲述' },
    { voice: 'en-US-RogerNeural', name: 'Roger', accent: '美式', gender: '男声', tone: '活泼有情绪' },
    { voice: 'en-US-BrianMultilingualNeural', name: 'Brian', accent: '美式', gender: '男声', tone: '轻松真诚' },
    { voice: 'en-GB-SoniaNeural', name: 'Sonia', accent: '英式', gender: '女声', tone: '英式播客' },
    { voice: 'en-GB-LibbyNeural', name: 'Libby', accent: '英式', gender: '女声', tone: '柔和亲切' },
    { voice: 'en-GB-RyanNeural', name: 'Ryan', accent: '英式', gender: '男声', tone: '清楚自然' }
  ];
  var DEFAULT_VOICE = VOICES[0].voice;

  function allows(voice) {
    return VOICES.some(function (item) { return item.voice === voice; });
  }

  function current() {
    try {
      var saved = localStorage.getItem(KEY);
      if (allows(saved)) return saved;
    } catch (_) {}
    return DEFAULT_VOICE;
  }

  function meta(voice) {
    var id = voice || current();
    for (var i = 0; i < VOICES.length; i++) {
      if (VOICES[i].voice === id) return VOICES[i];
    }
    return VOICES[0];
  }

  function accentCode(voice) {
    return meta(voice).accent === '英式' ? 'uk' : 'us';
  }

  function set(voice) {
    if (!allows(voice)) return false;
    try {
      localStorage.setItem(KEY, voice);
      // Mirror accent for scene filtering; switch UI lives only in membership center.
      localStorage.setItem(ACCENT_KEY, accentCode(voice));
    } catch (_) { return false; }
    return true;
  }

  function synthesisLang() {
    return current().indexOf('en-GB') === 0 ? 'en-GB' : 'en-US';
  }

  // 从系统音色里挑一个尽量接近所选神经音色的：先按同名匹配，再按口音，最后任意英语。
  function findSystemVoice(voices) {
    if (!voices || !voices.length) return null;
    var info = meta();
    var lang = synthesisLang();
    function langOf(v) {
      return String((v && v.lang) || '').replace('_', '-');
    }
    var byName = new RegExp(info.name, 'i');
    for (var i = 0; i < voices.length; i++) {
      if (langOf(voices[i]).indexOf(lang) === 0 && byName.test(voices[i].name || '')) return voices[i];
    }
    for (var j = 0; j < voices.length; j++) {
      if (langOf(voices[j]).indexOf(lang) === 0) return voices[j];
    }
    for (var k = 0; k < voices.length; k++) {
      if (/^en/i.test(langOf(voices[k]))) return voices[k];
    }
    return null;
  }

  global.LinglishTtsVoice = {
    KEY: KEY,
    ACCENT_KEY: ACCENT_KEY,
    VOICES: VOICES,
    DEFAULT_VOICE: DEFAULT_VOICE,
    allows: allows,
    current: current,
    set: set,
    meta: meta,
    accentCode: accentCode,
    synthesisLang: synthesisLang,
    findSystemVoice: findSystemVoice
  };
})(window);

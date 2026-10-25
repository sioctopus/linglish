(function (global) {
  var KEY = 'linglish_tts_voice';
  var VOICES = [
    { voice: 'en-US-AvaMultilingualNeural', name: 'Ava', accent: '美式', gender: '女声', tone: '自然聊天' },
    { voice: 'en-US-AndrewMultilingualNeural', name: 'Andrew', accent: '美式', gender: '男声', tone: '自然聊天' },
    { voice: 'en-US-EmmaMultilingualNeural', name: 'Emma', accent: '美式', gender: '女声', tone: '清楚温和' },
    { voice: 'en-US-BrianMultilingualNeural', name: 'Brian', accent: '美式', gender: '男声', tone: '沉稳' },
    { voice: 'en-GB-LibbyNeural', name: 'Libby', accent: '英式', gender: '女声', tone: '柔和' },
    { voice: 'en-GB-MaisieNeural', name: 'Maisie', accent: '英式', gender: '女声', tone: '轻快' },
    { voice: 'en-GB-RyanNeural', name: 'Ryan', accent: '英式', gender: '男声', tone: '清楚' },
    { voice: 'en-GB-ThomasNeural', name: 'Thomas', accent: '英式', gender: '男声', tone: '沉稳' }
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

  function set(voice) {
    if (!allows(voice)) return false;
    try { localStorage.setItem(KEY, voice); } catch (_) { return false; }
    return true;
  }

  function meta(voice) {
    var id = voice || current();
    for (var i = 0; i < VOICES.length; i++) {
      if (VOICES[i].voice === id) return VOICES[i];
    }
    return VOICES[0];
  }

  // speechSynthesis 兜底用的 BCP-47 语言：跟随所选音色的口音，而不是固定 en-US。
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
    VOICES: VOICES,
    DEFAULT_VOICE: DEFAULT_VOICE,
    allows: allows,
    current: current,
    set: set,
    meta: meta,
    synthesisLang: synthesisLang,
    findSystemVoice: findSystemVoice
  };
})(window);

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishMediaLibraryDefaults = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 图一 + 图二 → 播客默认；图三及以后 → 频道库默认。
  const VERSION = '20261028a';

  const PODCASTS = [
    {
      id: 'miss-honey-slow-english',
      title: 'Miss Honey: Slow English Podcast',
      author: 'Tayanna Ortiz',
      query: 'Miss Honey Slow English Podcast',
      editorNote: '主持人说得慢、说得清楚，用真实生活故事练听力。常用词多，适合初级（A2）水平。',
      aboutEn: 'Learn English Naturally! :)\n\nWelcome to the Slow English Podcast. I speak slowly and clearly so you can follow real-life stories, grow your listening, and feel more confident week by week.\n\nNew episodes every week.\nHosted on Acast.',
    },
    { id: 'speak-english-now', title: 'Speak English Now Podcast', author: 'Georgiana', query: 'Speak English Now Podcast Georgiana' },
    { id: 'learn-english-through-listening', title: 'Learn English Through Listening', author: 'Hilary Phatt', query: 'Learn English Through Listening Adept English' },
    { id: 'spotlight-english', title: 'Spotlight English', author: 'Spotlight English', query: 'Spotlight English podcast' },
    { id: 'easy-stories-in-english', title: 'Easy Stories in English', author: 'Ariel Goodbody', query: 'Easy Stories in English Ariel Goodbody' },
    { id: 'daily-easy-english-expression', title: 'Daily Easy English Expression Podcast', author: 'Coach Shane', query: 'Daily Easy English Expression Podcast Coach Shane' },
    { id: 'englishclass101', title: 'Learn English | EnglishClass101.com', author: 'EnglishClass101.com', query: 'EnglishClass101.com podcast' },
    { id: 'coffee-break-english', title: 'Learn English with Coffee Break English', author: 'Coffee Break Languages', query: 'Coffee Break English podcast' },
    { id: '6-minute-english', title: '6 Minute English', author: 'BBC Radio', query: '6 Minute English BBC' },
    { id: 'learning-english-conversations', title: 'Learning English Conversations', author: 'BBC Radio', query: 'Learning English Conversations BBC' },
    { id: 'learning-english-grammar', title: 'Learning English Grammar', author: 'BBC Radio', query: 'Learning English Grammar BBC podcast' },
    { id: 'learning-english-for-work', title: 'Learning English For Work', author: 'BBC News', query: 'Learning English For Work BBC' },
    { id: 'phrasal-verb-a-day', title: 'A Phrasal Verb a Day', author: 'Luke Thompson', query: 'A Phrasal Verb a Day Luke Thompson' },
    { id: 'listening-time-english-practice', title: 'Listening Time: English Practice', author: 'Sonora', query: 'Listening Time English Practice podcast' },
    { id: 'english-vocabulary-help', title: 'English Vocabulary Help', author: 'English With Kayla', query: 'English Vocabulary Help Kayla' },
    { id: 'pronunciation-with-emma-podcast', title: 'Pronunciation with Emma Podcast', author: 'Pronunciation with Emma', query: 'Pronunciation with Emma Podcast' },
    { id: 'easy-english-podcast', title: 'Easy English Podcast', author: 'Oliver', query: 'Easy English Podcast Oliver' },
    { id: 'go-natural-english-podcast', title: 'Go Natural English Podcast', author: 'Go Natural English', query: 'Go Natural English Podcast' },
    { id: 'simple-english-news-daily', title: 'Simple English News Daily', author: 'SEND7', query: 'Simple English News Daily SEND7' },
    { id: 'learning-english-from-the-news', title: 'Learning English from the News', author: 'BBC Radio', query: 'Learning English from the News BBC' },
    { id: 'bob-the-canadian-podcast', title: 'Learn English with Bob the Canadian', author: 'Bob the Canadian', query: 'Learn English with Bob the Canadian podcast' },
    { id: 'culips-everyday-english', title: 'Culips Everyday English Podcast', author: 'Culips English Podcast', query: 'Culips Everyday English Podcast' },
    { id: 'american-english-podcast', title: 'American English Podcast', author: 'Shana Thompson', query: 'American English Podcast Shana Thompson' },
    { id: 'all-ears-english', title: 'All Ears English Podcast', author: 'Lindsay McMahon', query: 'All Ears English Podcast' },
    { id: 'real-english-conversations', title: 'Real English Conversations', author: 'Real English Conversations', query: 'Real English Conversations podcast' },
    { id: 'real-life-english-gabby', title: 'The Real Life English with Gabby Podcast', author: 'Gabby', query: 'Real Life English with Gabby Podcast' },
    { id: 'real-life-english-camille', title: 'Real Life English with Camille', author: 'Learn English with Camille', query: 'Real Life English with Camille podcast' },
    { id: 'level-up-english', title: 'The Level Up English Podcast', author: 'Michael Lavers', query: 'Level Up English Podcast Michael Lavers' },
    { id: 'english-like-a-native', title: 'English Like A Native Podcast', author: 'Anna Tyrie', query: 'English Like A Native Podcast' },
    { id: 'woo-pod', title: 'Woo Pod', author: 'Susie Woo', query: 'Woo Pod Susie Woo' },
    { id: 'english-with-thiago', title: 'English with Thiago', author: 'Thiago Alencar', query: 'English with Thiago podcast' },
    { id: 'speak-better-english-harry', title: 'Speak Better English with Harry', author: 'Harry', query: 'Speak Better English with Harry podcast' },
    { id: 'thinking-in-english', title: 'Thinking in English', author: 'Thomas Wilkinson', query: 'Thinking in English Thomas Wilkinson' },
    { id: 'curious-minds', title: 'English Learning for Curious Minds', author: 'Leonardo English', query: 'English Learning for Curious Minds Leonardo' },
    { id: 'into-the-story', title: 'Into the Story', author: 'Bree Aesie', query: 'Into the Story Bree Aesie podcast' },
    { id: 'british-english-podcast', title: 'The British English Podcast', author: 'Charlie Baxter', query: 'The British English Podcast Charlie Baxter' },
    { id: 'business-english-all-ears', title: 'Business English from All Ears English', author: 'Lindsay McMahon', query: 'Business English from All Ears English' },
    { id: 'confident-business-english', title: 'Confident Business English', author: 'Anna Connelly', query: 'Confident Business English Anna Connelly' },
    { id: 'ielts-speaking-for-success', title: 'IELTS Speaking for Success', author: 'Podcourses', query: 'IELTS Speaking for Success Podcourses' },
    { id: 'ielts-energy-english', title: 'IELTS Energy English 7+', author: 'Lindsay McMahon', query: 'IELTS Energy English 7+' },
    { id: 'think-fast-talk-smart', title: 'Think Fast Talk Smart', author: 'Matt Abrahams', query: 'Think Fast Talk Smart Communication podcast' },
    { id: 'hidden-brain', title: 'Hidden Brain', author: 'Shankar Vedantam', query: 'Hidden Brain podcast' },
    { id: 'freakonomics-radio', title: 'Freakonomics Radio', author: 'Freakonomics Radio', query: 'Freakonomics Radio podcast' },
    { id: 'lennys-podcast', title: "Lenny's Podcast", author: 'Lenny Rachitsky', query: "Lenny's Podcast Lenny Rachitsky" },
  ];

  const CHANNELS = [
    {
      id: 'listening-time',
      title: 'English Listening Time',
      handle: 'EnglishListeningTime',
      editorNote: '慢速、清晰的真实生活英语听力。适合想练耳朵、又怕语速太快的学习者。',
    },
    {
      id: 'volka-english',
      title: 'Volka English',
      handle: 'VolkaEnglish',
      editorNote: '可理解输入式英语：慢速、真实生活的听力 vlog，以及在日常外出中拍摄的慢速英语播客。语速清晰缓慢，面向初级（A2）水平。',
      aboutEn: 'Making English Fun.\n\nEmail: volka@volkaenglish.com\nOur official representative agency: Influencers Genius\nEmail: volka@influencersgenius.com',
    },
    { id: 'ariannita-la-gringa', title: 'Ariannita la Gringa', handle: 'AriannitalaGringa' },
    {
      id: 'miss-honey-yt',
      title: 'Miss Honey',
      handle: 'MissHoneyEnglish',
      editorNote: '慢速清晰的生活英语。跟着主持人日常说话练听力，适合初级（A2）水平。',
    },
    { id: 'bob-the-canadian', title: 'Learn English with Bob the Canadian', handle: 'LearnEnglishWithBobTheCanadian' },
    { id: 'english-addict-mr-duncan', title: 'English Addict with Mr Duncan', handle: 'duncaninchina' },
    { id: 'shaw-english-online', title: 'Shaw English Online', handle: 'ShawEnglish' },
    { id: 'rachels-english', title: "Rachel's English", handle: 'RachelsEnglish' },
    { id: 'leahs-diary', title: "Leah's Diary 莉雅老师", handle: 'LeahsDiary' },
    { id: 'smashing-english', title: 'Smashing English! Free and Fun English Lessons!', handle: 'SmashingEnglish' },
    { id: 'english-with-katharine', title: 'English with Katharine', handle: 'EnglishwithKatharine' },
    { id: 'english-fluency-journey', title: 'English Fluency Journey', handle: 'EnglishFluencyJourney' },
    { id: 'the-english-class', title: 'The English Class', handle: 'TheEnglishClass' },
    { id: 'english-with-lucy', title: 'English with Lucy', handle: 'EnglishwithLucy' },
    { id: 'english-speaking-success', title: 'English Speaking Success', handle: 'EnglishSpeakingSuccess' },
    { id: 'pronunciation-with-emma', title: 'Pronunciation with Emma', handle: 'pronunciationwithemma' },
    { id: 'bbc-learning-english', title: 'BBC Learning English', handle: 'bbclearningenglish' },
    { id: 'adept-english', title: 'Adept English', handle: 'adeptenglish' },
    { id: 'speak-english-with-tiffani', title: 'Speak English With Tiffani', handle: 'SpeakEnglishWithTiffani' },
    { id: 'mmmenglish', title: 'mmmEnglish', handle: 'mmmEnglish_Emma' },
    { id: 'to-fluency', title: 'To Fluency', handle: 'tofluency' },
    { id: 'english-with-cambridge', title: 'English with Cambridge', handle: 'CambridgeEnglishTV' },
    { id: 'learn-english-with-harry', title: 'Learn English with Harry', handle: 'LearnEnglishWithHarry' },
    { id: 'silicon-valley-girl', title: 'Silicon Valley Girl', handle: 'SiliconValleyGirl' },
    { id: 'bbc-ideas', title: 'BBC Ideas', handle: 'BBCIdeas' },
    { id: 'improve-english-evelyn', title: 'Improve your English with Evelyn', handle: 'ImproveEnglishWithEvelyn' },
    { id: 'go-natural-english', title: 'Go Natural English - Real Life English with Gabby', handle: 'GoNaturalEnglish' },
    { id: 'english-speeches', title: 'English Speeches', handle: 'EnglishSpeeches' },
    { id: 'learn-english-with-tv-series', title: 'Learn English With TV Series', handle: 'LearnEnglishWithTVSeries' },
    { id: 'ielts-advantage', title: 'IELTS Advantage', handle: 'IELTSadvantage' },
    { id: 'ted', title: 'TED', handle: 'TED' },
    { id: 'crashcourse', title: 'CrashCourse', handle: 'crashcourse' },
    { id: 'veritasium', title: 'Veritasium', handle: 'veritasium' },
    { id: 'bbc-earth', title: 'BBC Earth', handle: 'bbcearth' },
    { id: 'lex-fridman', title: 'Lex Fridman', handle: 'lexfridman' },
    { id: 'lennys-podcast-yt', title: "Lenny's Podcast", handle: 'LennysPodcast' },
    { id: 'ted-ed', title: 'TED-Ed', handle: 'TEDEd' },
    { id: 'kurzgesagt', title: 'Kurzgesagt – In a Nutshell', handle: 'kurzgesagt' },
    { id: 'peter-rabbit', title: 'Peter Rabbit', handle: 'OfficialPeterRabbit' },
  ];

  function seedFeedUrl(id) {
    return `seed:podcast:${id}`;
  }

  function seedChannelId(id) {
    return `seed:${id}`;
  }

  function normalizeTitle(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeHandle(value) {
    const raw = String(value || '');
    const fromUrl = (raw.match(/youtube\.com\/@([^/?#]+)/i) || [])[1]
      || (raw.match(/youtube\.com\/(?:c|user)\/([^/?#]+)/i) || [])[1]
      || '';
    return String(fromUrl || raw)
      .replace(/^@/, '')
      .toLowerCase()
      .trim();
  }

  function buildPodcastDefaults() {
    return PODCASTS.map((item) => ({
      defaultId: item.id,
      feedUrl: seedFeedUrl(item.id),
      title: item.title,
      author: item.author || '',
      image: '',
      description: item.aboutEn || item.author || '',
      editorNote: item.editorNote || '',
      about: item.aboutEn || '',
      query: item.query || item.title,
      episodes: [],
      seeded: true,
    }));
  }

  function buildChannelDefaults() {
    return CHANNELS.map((item) => ({
      defaultId: item.id,
      channelId: seedChannelId(item.id),
      handle: item.handle || '',
      title: item.title,
      pageUrl: item.handle ? `https://www.youtube.com/@${item.handle}` : '',
      description: item.editorNote || '官方精选频道',
      editorNote: item.editorNote || '',
      about: item.aboutEn || '',
      image: '',
      videos: [],
      seeded: true,
    }));
  }

  function patchMissingImages(existing, defaults, keyName) {
    const list = Array.isArray(existing) ? existing.slice() : [];
    const byKey = new Map(defaults.map((item) => [String(item && item[keyName] || ''), item]));
    return list.map((item) => {
      if (!item || item.image) return item;
      const fallback = byKey.get(String(item[keyName] || ''));
      if (!fallback) return item;
      if (fallback.image) return { ...item, image: fallback.image };
      return item;
    });
  }

  function findPodcastDuplicate(list, podcast) {
    const items = Array.isArray(list) ? list : [];
    const feed = String(podcast && podcast.feedUrl || '').trim().toLowerCase();
    const title = normalizeTitle(podcast && podcast.title);
    const defaultId = String(podcast && podcast.defaultId || '').trim();
    return items.find((item) => {
      if (defaultId && item.defaultId === defaultId) return true;
      if (feed && String(item.feedUrl || '').trim().toLowerCase() === feed) return true;
      if (title && normalizeTitle(item.title) === title) return true;
      return false;
    }) || null;
  }

  function findChannelDuplicate(list, channel) {
    const items = Array.isArray(list) ? list : [];
    const id = String(channel && channel.channelId || '').trim();
    const youtubeId = String(channel && channel.youtubeChannelId || '').trim();
    const handle = normalizeHandle(channel && (channel.handle || channel.pageUrl));
    const title = normalizeTitle(channel && channel.title);
    const defaultId = String(channel && channel.defaultId || '').trim();
    return items.find((item) => {
      if (defaultId && item.defaultId === defaultId) return true;
      if (id && (item.channelId === id || item.youtubeChannelId === id)) return true;
      if (youtubeId && (item.channelId === youtubeId || item.youtubeChannelId === youtubeId)) return true;
      if (handle && normalizeHandle(item.handle || item.pageUrl) === handle) return true;
      if (title && normalizeTitle(item.title) === title) return true;
      return false;
    }) || null;
  }

  function mergeDefaults(existing, defaults, keyName) {
    const list = Array.isArray(existing) ? existing.slice() : [];
    const seen = new Set(list.map((item) => String(item && item[keyName] || '')));
    defaults.forEach((item) => {
      const key = String(item && item[keyName] || '');
      if (!key || seen.has(key)) return;
      if (keyName === 'feedUrl' && findPodcastDuplicate(list, item)) return;
      if (keyName === 'channelId' && findChannelDuplicate(list, item)) return;
      list.push(item);
      seen.add(key);
    });
    return list;
  }

  // Refresh catalog metadata on version bump (fix stale handles / empty seeds).
  function reconcileChannelDefaults(existing) {
    const defaults = buildChannelDefaults();
    const byDefaultId = new Map(defaults.map((item) => [String(item.defaultId || ''), item]));
    return (Array.isArray(existing) ? existing : []).map((item) => {
      if (!item) return item;
      const def = byDefaultId.get(String(item.defaultId || ''));
      if (!def) return item;
      const handleChanged = normalizeHandle(item.handle || item.pageUrl) !== normalizeHandle(def.handle);
      const seeded = item.seeded || String(item.channelId || '').startsWith('seed:');
      if (!handleChanged && !seeded) return item;
      return {
        ...item,
        title: def.title || item.title,
        handle: def.handle || item.handle,
        pageUrl: def.pageUrl || item.pageUrl,
        editorNote: def.editorNote || item.editorNote || '',
        description: def.editorNote || item.description || '',
        videos: handleChanged || seeded ? [] : (item.videos || []),
        seeded: handleChanged || seeded ? true : !!item.seeded,
      };
    });
  }

  return {
    VERSION,
    PODCASTS,
    CHANNELS,
    seedFeedUrl,
    seedChannelId,
    normalizeTitle,
    normalizeHandle,
    buildPodcastDefaults,
    buildChannelDefaults,
    patchMissingImages,
    findPodcastDuplicate,
    findChannelDuplicate,
    mergeDefaults,
    reconcileChannelDefaults,
  };
});

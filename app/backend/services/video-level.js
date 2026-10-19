/**
 * Classify a transcript into A1, A2, B1, B2, C1, or C2.
 *
 * The primary signal is how much of the content vocabulary sits inside
 * each frequency band. Sentence length and word length are only a backup
 * when the dictionary does not cover the transcript, and they can nudge
 * the vocabulary result by one band.
 */

const LEVELS = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];

const LEGACY_LEVELS = {
  beginner: 'a1',
  intermediate: 'b1',
  advanced: 'c1',
};

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'so', 'of', 'to', 'in', 'on', 'at', 'for', 'from',
  'with', 'by', 'as', 'into', 'about', 'over', 'after', 'before', 'between', 'through', 'during',
  'without', 'within', 'than', 'then', 'that', 'this', 'these', 'those', 'it', 'its', 'he', 'she',
  'they', 'we', 'you', 'i', 'me', 'my', 'your', 'his', 'her', 'their', 'our', 'him', 'them', 'us',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'have', 'has', 'had',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'not', 'no', 'yes', 'what',
  'who', 'when', 'where', 'why', 'how', 'which', 'there', 'here',
]);

const COVERAGE_BANDS = [
  { level: 'a1', maxRank: 800, minCoverage: 0.9 },
  { level: 'a2', maxRank: 1500, minCoverage: 0.88 },
  { level: 'b1', maxRank: 2500, minCoverage: 0.85 },
  { level: 'b2', maxRank: 4500, minCoverage: 0.82 },
  { level: 'c1', maxRank: 8000, minCoverage: 0.78 },
];

function canonicalLevel(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (LEGACY_LEVELS[value]) return LEGACY_LEVELS[value];
  return LEVELS.includes(value) ? value : null;
}

function levelIndex(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? 0 : index;
}

function tokensOf(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z'\-\s]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter((word) => word.length >= 2 && word.length <= 30 && /^[a-z]/.test(word));
}

function lookupRank(word, rankByWord) {
  if (!rankByWord) return null;
  const direct = Number(rankByWord[word]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const bare = word.replace(/'/g, '');
  if (bare === word) return null;
  const alt = Number(rankByWord[bare]);
  return Number.isFinite(alt) && alt > 0 ? alt : null;
}

function bandForRank(rank) {
  if (rank <= 800) return 'a1';
  if (rank <= 1500) return 'a2';
  if (rank <= 2500) return 'b1';
  if (rank <= 4500) return 'b2';
  if (rank <= 8000) return 'c1';
  return 'c2';
}

function emptyStats(total = 0) {
  return { a1: 0, a2: 0, b1: 0, b2: 0, c1: 0, c2: 0, unknown: 0, total };
}

function structuralLevel(text, words) {
  if (!words.length) return null;
  const endings = (String(text || '').match(/[.!?]+/g) || []).length;
  const reliable = endings >= 1 && words.length / endings <= 45;
  let score = 0;
  if (reliable) {
    const avgSentence = words.length / endings;
    if (avgSentence >= 8) score += 1;
    if (avgSentence >= 12) score += 1;
    if (avgSentence >= 18) score += 1;
    if (avgSentence >= 26) score += 1;
  }
  const avgWord = words.reduce((sum, word) => sum + word.length, 0) / words.length;
  if (avgWord >= 4.5) score += 1;
  if (avgWord >= 5.3) score += 1;
  if (avgWord >= 6.2) score += 1;
  const longRatio = words.filter((word) => word.length >= 8).length / words.length;
  if (longRatio >= 0.08) score += 1;
  if (longRatio >= 0.18) score += 1;
  if (longRatio >= 0.32) score += 1;
  const lower = String(text || '').toLowerCase();
  const midMarkers = (lower.match(/\b(however|therefore|whereas|although|despite)\b/g) || []).length;
  const advancedMarkers = (lower.match(/\b(nevertheless|furthermore|moreover|notwithstanding|albeit|consequently)\b/g) || []).length;
  if (midMarkers > 0) score += 1;
  if (advancedMarkers > 0) score += 2;
  if (score <= 0) return 'a1';
  if (score === 1) return 'a2';
  if (score <= 3) return 'b1';
  if (score <= 5) return 'b2';
  if (score <= 7) return 'c1';
  return 'c2';
}

function lexicalProfile(contentTokens, rankByWord) {
  const stats = emptyStats(contentTokens.length);
  const bandCounts = emptyStats(0);
  let known = 0;
  let weighted = 0;
  contentTokens.forEach((word) => {
    const rank = lookupRank(word, rankByWord);
    if (rank == null) {
      stats.unknown += 1;
      return;
    }
    const band = bandForRank(rank);
    const weight = levelIndex(band) + 1;
    known += 1;
    weighted += weight;
    bandCounts[band] += 1;
    stats[band] += 1;
  });

  const coverage = contentTokens.length ? known / contentTokens.length : 0;
  if (known < 8 || coverage < 0.45) {
    return { difficulty: null, score: null, stats, known };
  }

  const cumulative = {
    a1: bandCounts.a1,
    a2: bandCounts.a1 + bandCounts.a2,
    b1: bandCounts.a1 + bandCounts.a2 + bandCounts.b1,
    b2: bandCounts.a1 + bandCounts.a2 + bandCounts.b1 + bandCounts.b2,
    c1: known - bandCounts.c2,
  };

  let difficulty = 'c2';
  for (const band of COVERAGE_BANDS) {
    if (cumulative[band.level] / known >= band.minCoverage) {
      difficulty = band.level;
      break;
    }
  }

  return {
    difficulty,
    score: Number((weighted / known).toFixed(2)),
    stats,
    known,
  };
}

function classifyTranscript(text, rankByWord = {}) {
  const source = String(text || '');
  const words = tokensOf(source);
  if (!words.length) {
    return { difficulty: null, score: null, source: 'empty', stats: emptyStats(0) };
  }

  const contentTokens = words.filter((word) => !STOPWORDS.has(word));
  const profileTokens = contentTokens.length >= 8 ? contentTokens : words;
  const lexical = lexicalProfile(profileTokens, rankByWord);
  const structure = structuralLevel(source, words);

  if (!lexical.difficulty) {
    return { difficulty: structure, score: null, source: 'structure', stats: lexical.stats };
  }

  let index = levelIndex(lexical.difficulty);
  const structureIndex = levelIndex(structure);
  const longUnknown = profileTokens.filter((word) => lookupRank(word, rankByWord) == null && word.length >= 9).length;
  const rareShare = lexical.known ? (lexical.stats.c1 + lexical.stats.c2) / lexical.known : 0;
  if (structureIndex >= index + 2 || longUnknown / profileTokens.length >= 0.12) {
    index += 1;
  } else if (structureIndex + 2 <= index && rareShare < 0.04) {
    index -= 1;
  }

  return {
    difficulty: LEVELS[Math.max(0, Math.min(LEVELS.length - 1, index))],
    score: lexical.score,
    source: 'vocabulary',
    stats: lexical.stats,
  };
}

module.exports = {
  LEVELS,
  canonicalLevel,
  classifyTranscript,
};

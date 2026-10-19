'use strict';

function clampText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function localExplanation({ text, translation, word }) {
  const lines = [`整句：${text}`];
  if (translation) lines.push(`意思：${translation}`);
  if (word) lines.push(`先看 “${word}” 在这句里怎么用，再整句跟读。`);
  else lines.push('先听清重读的词，再按原句的节奏跟读一遍。');
  return lines.join('\n');
}

function requiredText(text) {
  const value = clampText(text, 800);
  if (!value) {
    const error = new Error('TEXT_REQUIRED');
    error.status = 400;
    throw error;
  }
  return value;
}

async function defaultModel({ text, translation, word, userId }) {
  const dataStore = require('../data-store');
  const AITutorService = require('../ai-services/ai-tutor-service');
  const tutor = new AITutorService(dataStore);
  const prompt = [
    '你是英语带教老师。用简体中文讲解下面这句，80到140字。',
    '依次说明：整句意思、一个语法或搭配、跟读时要注意的节奏。',
    '不要用标题，不要用 Markdown。',
    `句子：${text}`,
    translation ? `已有译文：${translation}` : '',
    word ? `学员点中的词：${word}` : '',
  ].filter(Boolean).join('\n');
  return tutor.callOpenAI({
    userId: userId || null,
    purpose: 'coaching_explain',
    messages: [
      { role: 'system', content: '你是耐心的英语带教老师，只输出讲解正文。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.4,
    maxTokens: 280,
  });
}

async function defaultTranslate(text) {
  const { translateWithGoogle } = require('./translation/providers/google');
  const { translateWithMyMemory } = require('./translation/providers/mymemory');
  try {
    const translation = clampText(await translateWithGoogle(text), 800);
    if (translation) return { translation, source: 'google' };
  } catch (_) { /* try the next provider */ }
  const translation = clampText(await translateWithMyMemory(text), 800);
  if (!translation) {
    const error = new Error('TRANSLATION_UNAVAILABLE');
    error.status = 502;
    throw error;
  }
  return { translation, source: 'mymemory' };
}

function localAnalysis(text) {
  try {
    const analyzer = require('../../frontend/js/video-reader/sentence-analysis');
    return analyzer.analyze(text);
  } catch (_) {
    return null;
  }
}

async function explainSentence(input, deps = {}) {
  const text = requiredText(input && input.text);
  const translation = clampText(input && input.translation, 800);
  const word = clampText(input && input.word, 80);
  const payload = { text, translation, word, userId: input && input.userId };
  const model = typeof deps.model === 'function' ? deps.model : (deps.allowModel === false ? null : defaultModel);
  if (model) {
    try {
      const content = await model(payload);
      const explanation = clampText(typeof content === 'string' ? content : content && content.explanation, 1200);
      if (explanation) return { explanation, source: (content && content.source) || 'ai', analysis: localAnalysis(text) };
    } catch (error) {
      if (deps.strict) throw error;
    }
  }
  return { explanation: localExplanation(payload), source: 'local', analysis: localAnalysis(text) };
}

async function translateSentence(text, deps = {}) {
  const sourceText = requiredText(text);
  if (typeof deps.translate === 'function') {
    const result = await deps.translate(sourceText);
    const translation = clampText(typeof result === 'string' ? result : result && result.translation, 800);
    if (!translation) {
      const error = new Error('TRANSLATION_UNAVAILABLE');
      error.status = 502;
      throw error;
    }
    return { translation, source: (result && result.source) || 'provider' };
  }
  return defaultTranslate(sourceText);
}

module.exports = {
  explainSentence,
  localExplanation,
  translateSentence,
};

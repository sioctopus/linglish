// Import core functionality
const {
  pool,
  init,
  isDatabaseAvailable,
  assertDbAvailable,
  dbUnavailable,
} = require('./core');

// Import query modules
const usersQueries = require('./queries/users');
const trainingQueries = require('./queries/training');
const videosQueries = require('./queries/videos');
const creatorsQueries = require('./queries/creators');
const vocabularyQueries = require('./queries/vocabulary');
const pronunciationQueries = require('./queries/pronunciation');
const roleplayQueries = require('./queries/roleplay');
const aiRoleplayQueries = require('./queries/ai-roleplay');
const feedbackQueries = require('./queries/feedback');
const analyticsQueries = require('./queries/analytics');
const dictionaryQueries = require('./queries/dictionary');
const translationQueries = require('./queries/translation');
const communityQueries = require('./queries/community');
const practiceShareQueries = require('./queries/practice-shares');
const teamLeadQueries = require('./queries/team-leads');

// Convenience query passthrough
async function query(sql, params = []) {
  await init();
  return pool.query(sql, params);
}

// Export everything in a single export statement
module.exports = {
  // Core
  pool,
  init,
  isDatabaseAvailable,
  assertDbAvailable,
  dbUnavailable,
  query,

  // Users queries
  ...usersQueries,

  // Training queries
  ...trainingQueries,

  // Videos queries
  ...videosQueries,
  ...creatorsQueries,

  // Vocabulary queries
  ...vocabularyQueries,

  // Pronunciation queries
  ...pronunciationQueries,

  // Roleplay queries
  ...roleplayQueries,
  ...aiRoleplayQueries,

  // Feedback queries
  ...feedbackQueries,

  // Analytics queries
  ...analyticsQueries,

  // Dictionary cache
  ...dictionaryQueries,

  // Translation cache
  ...translationQueries,

  // Community
  ...communityQueries,

  // Practice share
  ...practiceShareQueries,

  // Team / enterprise leads
  ...teamLeadQueries,
};

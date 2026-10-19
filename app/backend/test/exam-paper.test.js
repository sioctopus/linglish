const test = require('node:test');
const assert = require('node:assert/strict');
const { answerSpeech, buildExamPaper } = require('../services/exam-paper');

test('answer keys are spoken letter by letter', () => {
  assert.equal(answerSpeech('1-5 BACCA'), '第1到第5题的答案是 B，A，C，C，A');
  assert.match(answerSpeech('56. To write down all the meals.'), /第56题，To write down all the meals\./);
});

test('plain exam text keeps questions, a passage, and the answer key', () => {
  const text = [
    '第一部分 听力（满分20分）',
    'Homework clubs are popular in many schools in the U.S. Most students spend their afternoon there and finish homework.',
    '1. What animal does Amy think is playful?',
    'A. The panda.',
    'B. The monkey.',
    'C. The tiger.',
    '2. What time does Ann usually go to bed?',
    'A. At 9:00 p.m.',
    'B. At 10:00 p.m.',
    'C. At 11:00 p.m.',
    '3. What is Mrs. Hu\'s job?',
    'A. A Chinese teacher.',
    'B. An English teacher.',
    'C. A math teacher.',
    '参考答案',
    '1-3 BAC',
  ].join('\n');
  const paper = buildExamPaper(text, '期中试卷');
  assert.equal(paper.kind, 'exam-paper');
  assert.equal(paper.blocks.filter((block) => block.type === 'question').length, 3);
  assert.ok(paper.blocks.some((block) => block.type === 'passage'));
  assert.match(paper.blocks.find((block) => block.type === 'answer').lines[0].speak, /B，A，C/);
});

test('a short lesson is not treated as an exam', () => {
  assert.equal(buildExamPaper('Good morning. How are you today?', '课文'), null);
});

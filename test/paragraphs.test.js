const test = require('node:test');
const assert = require('node:assert');
const {paragraphStarts, assemble, emptyReview} = require('../src/core/review');

// "…epic proportions. Something that simply What needs to be noted. And then…", split by the engine as
// "Something that simply" | "What" | "needs to be noted." | "And then you had it."
function work({breaks, edits = [], speakers = null}) {
  const text = 'It was a crash of epic proportions. Something that simply What needs to be noted. And then you had it.';
  const words = text.split(' ').map((t, i) => ({text: t, s: i, e: i + 0.5}));
  const cut = [0, 7, 10, 11, 15, words.length];
  const segments = cut.slice(0, -1).map((w0, k) => ({id: `s${k + 1}`, w0, w1: cut[k + 1], start: w0, end: cut[k + 1] - 0.5,
    speaker: speakers ? speakers[k] : null}));
  return {transcript: {words, segments, speakers: speakers ? [{label: 'A'}, {label: 'B'}] : []}, claude: {paragraphs: breaks, edits}};
}

test('a break inside a sentence moves to where the sentence begins', () => {
  // Claude chose the segment that starts at "needs" (11); the sentence begins at "What" (10).
  const w = work({breaks: [0, 11], edits: [{w1: 7, w2: 10, text: 'Something that simply—'}]});
  assert.deepEqual([...paragraphStarts(w)].sort((a, b) => a - b), [0, 10]);
});

test('without an edit, a common word written with a capital marks the start', () => {
  const w = work({breaks: [0, 11]});
  w.transcript.words.push({text: 'what', s: 30, e: 30.5});   // seen in lower case elsewhere
  assert.deepEqual([...paragraphStarts(w)].sort((a, b) => a - b), [0, 10]);
});

test('breaks that already start a sentence, or a new voice, stay where they are', () => {
  assert.deepEqual([...paragraphStarts(work({breaks: [0, 7, 15]}))].sort((a, b) => a - b), [0, 7, 15]);
  const w = work({breaks: [0, 11], speakers: ['A', 'A', 'A', 'B', 'B']});
  assert.deepEqual([...paragraphStarts(w)].sort((a, b) => a - b), [0, 11]);
});

test('you can start a paragraph and join one, and the export follows', () => {
  const w = work({breaks: [0, 7, 15]});
  const review = {...emptyReview(), paragraphs: {add: [10], remove: [15]}};
  assert.deepEqual([...paragraphStarts(w, review)].sort((a, b) => a - b), [0, 7, 10]);
  const paras = assemble(w, review).filter(b => b.type === 'p').map(b => b.text);
  assert.deepEqual(paras, ['It was a crash of epic proportions.', 'Something that simply',
    'What needs to be noted. And then you had it.']);
});

const test = require('node:test');
const assert = require('node:assert');
const {groupOf, items} = require('../src/core/review');
const {addWord, lowerForms, nameLike, noteFix, declineFix, fixOffer} = require('../src/core/wordlist');

const words = text => text.split(' ').map((t, i) => ({text: t, s: i, e: i + 0.5, filler: /^(um|uh)$/i.test(t)}));
// An edit of the words from w1 up to w2.
const edit = (w1, w2, text, kind = 'style', reason = '') => ({type: 'edit', w1, w2, text, kind, reason});

test('edits fall into the group of what they do to the words', () => {
  const w = words('I I think the U. S. went to Macon. November 4th, 2026. he said quote, the end and the the parish uh th- the');
  assert.equal(groupOf(edit(0, 3, 'I think', 'word', 'A stutter.'), w), 'stutters');
  assert.equal(groupOf(edit(0, 3, 'I think', 'word'), w), 'stutters', 'a repeated word is a stutter whatever the reason says');
  assert.equal(groupOf(edit(18, 21, 'the parish', 'word'), w), 'stutters');
  assert.equal(groupOf(edit(21, 23, ''), w), 'stutters', 'um and uh aside, a fragment of the next word is a false start');
  assert.equal(groupOf(edit(3, 4, 'The', 'punctuation'), w), 'punctuation');
  assert.equal(groupOf(edit(8, 9, 'Macon,', 'punctuation'), w), 'punctuation');
  assert.equal(groupOf(edit(4, 5, 'U.S.'), w), 'style');
  assert.equal(groupOf(edit(5, 6, ''), w), 'style', 'the rest of a split abbreviation is not a stutter');
  assert.equal(groupOf(edit(9, 12, 'November 4, 2026.'), w), 'style');
  assert.equal(groupOf(edit(8, 9, 'Makin.', 'word', 'The case is Carson v. Makin.'), w), 'corrections');
  assert.equal(groupOf(edit(14, 16, '“the', 'quotation'), w), 'quotations');
  assert.equal(groupOf(edit(14, 16, '“the', 'style'), w), 'quotations', 'marks added are quotations whatever the kind');
});

test('flags are heard, headings and speakers are structure, and every item gets a group', () => {
  const w = {transcript: {words: words('Alicia Kellar and this is it'), segments: []}, flags: [{id: 'f1', w1: 1, w2: 2, parakeet: 'Kellar', whisper: 'Kellor'}],
    claude: {picks: {f1: {choice: 'other', text: 'Keller', confidence: 'high', reason: ''}}, edits: [{id: 'e1', w1: 4, w2: 5, text: 'is,', kind: 'punctuation', reason: ''}],
      headings: [{w: 0, text: 'Part I'}]}, wordList: []};
  const list = items(w, {});
  assert.deepEqual(list.map(it => [it.id, it.group]), [['h1', 'structure'], ['f1', 'hearing'], ['e1', 'punctuation']]);
});

test('a name is told from a common word by how the transcript writes it', () => {
  const lower = lowerForms(words('there is a man here who said it is so'));
  assert.ok(nameLike('Keller,', lower));
  assert.ok(nameLike('Marta Lindqvist', lower));
  assert.ok(!nameLike('There', lower), 'written in lower case elsewhere');
  assert.ok(!nameLike("it's", lower));
  assert.ok(!nameLike('U.S.', lower));
});

test('the same name fixed twice is offered for the word list, with every form heard', () => {
  let log = noteFix({}, 'job1:f1', {write: 'Keller,', heard: ['Kellar,', 'Kellor,']});
  assert.equal(fixOffer(log, [], 'Keller'), null, 'once is not enough');
  log = noteFix(log, 'job1:f1', {write: 'Keller,', heard: ['Kellar,']});
  assert.equal(fixOffer(log, [], 'Keller'), null, 'deciding the same place again does not count twice');
  log = noteFix(log, 'job2:f1', {write: 'Keller', heard: ['Kelner']});
  assert.deepEqual(fixOffer(log, [], 'Keller'), {write: 'Keller', heard: ['Kellar', 'Kelner'], times: 2});
  // What the list already has is not offered again.
  const list = addWord([], {write: 'Keller', heard: ['Kellar', 'Kelner']});
  assert.deepEqual(list, [{write: 'Keller', heard: ['Kellar', 'Kelner'], always: true, note: ''}]);
  assert.equal(fixOffer(log, list, 'Keller'), null);
  // Undoing a fix takes it out of the count; saying no stops the offer.
  assert.equal(fixOffer(noteFix(log, 'job2:f1', null), [], 'Keller'), null);
  assert.equal(fixOffer(declineFix(log, 'Keller,'), [], 'Keller'), null);
});

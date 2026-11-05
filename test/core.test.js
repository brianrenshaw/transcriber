const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {readAsr, toks} = require('../src/core/text');
const {SM} = require('../src/core/sm');
const {compareEngines} = require('../src/core/compare');
const {placeResult} = require('../src/core/ai');
const {items, assemble, progress, emptyReview, spanText} = require('../src/core/review');

// MacWhisper-shaped JSON from sentences, one segment each, a quarter second per word.
// "It|'s" splits a word into two pieces the way the engines do.
function asr(sentences) {
  let t = 0;
  return {segments: sentences.map(s => {
    const words = s.split(' ').flatMap(w => w.split('|').map((piece, k) => {
      const out = {text: (k ? '' : ' ') + piece, start: t, end: t + 200}; t += 250; return out;
    }));
    return {start: words[0].start, end: words[words.length - 1].end, text: s.replace(/\|/g, ''), words};
  })};
}

const P = asr([
  'It|\'s Monday, November 2, 2026.',
  'The article describes the use of puberty walkers and other treatments for minors in several states.',
  'Um, the court will hear the case in the spring, and a ruling is expected by the summer.',
  'He wrote, quote, the people have spoken and the result is clear, end quote.',
]);
const W = asr([
  'It is Monday, November 2nd, 2026.',
  'The article describes the use of puberty blockers and other treatments for minors in several states.',
  'The court will hear the case in the spring, and a ruling is expected by the summer.',
  'He wrote, quote, the people have spoken and the result is clear, end quote.',
]);

function work() {
  const p = readAsr(P), w = readAsr(W);
  const {flags} = compareEngines(p, w);
  return {transcript: p, flags, claude: {}};
}

test('pieces without a leading space join the word before', () => {
  const p = readAsr(P);
  assert.equal(p.words[0].text, "It's");
  assert.equal(p.segments.length, 4);
  assert.deepEqual(toks("It's 10% off").map(t => t[0]), ["it's", '10', 'percent', 'off']);
  assert.equal(p.tokens.find(t => t.t === "it's").w, 0);
});

test('a word the engines split differently is flagged as whole words on both sides', () => {
  const said = 'This is The Bulletin, a daily look at the news and the events of the week.';
  const cmp = (a, b) => compareEngines(readAsr(asr([said, a, said])), readAsr(asr([said, b, said]))).flags;
  // Whisper's hyphenated word against two of Parakeet's: choosing Whisper must not leave "level level".
  let [f] = cmp('An extension level event for the markets.', 'An extinction-level event for the markets.');
  assert.equal(f.parakeet, 'extension level');
  assert.equal(f.whisper, 'extinction-level');
  // And the other way round.
  [f] = cmp('An extinction-level event for the markets.', 'An extension level event for the markets.');
  assert.equal(f.parakeet, 'extinction-level');
  assert.equal(f.whisper, 'extension level');
  // A plain word stays one word.
  [f] = cmp('An extension level event for the markets.', 'An extinction level event for the markets.');
  assert.equal(f.parakeet, 'extension');
  assert.equal(f.whisper, 'extinction');
});

test('only a real disagreement becomes a flag', () => {
  const {flags} = work();
  assert.equal(flags.length, 1, JSON.stringify(flags));
  assert.equal(flags[0].parakeet, 'walkers');
  assert.equal(flags[0].whisper, 'blockers');
  assert.ok(flags[0].at > 0);
});

test("The AI's answer is placed on words, and edits inside a flag are dropped", () => {
  const wk = work();
  const placed = placeResult({
    flags: [{id: 'f1', choice: 'whisper', text: 'blockers', confidence: 'high', reason: 'Medical term.'}],
    edits: [
      {segment: 's3', find: 'the court', replace: 'The court', kind: 'style', reason: 'A sentence begins here.'},
      {segment: 's2', find: 'walkers', replace: 'blockers', kind: 'word', reason: 'Inside the flag.'},
      {segment: 's1', find: 'November 2', replace: 'Nov. 2', kind: 'style', reason: 'Abbreviate.'},
      {segment: 's9', find: 'x', replace: 'y', kind: 'style', reason: 'No such segment.'},
    ],
    paragraphs: ['s1', 's3'],
    headings: [{segment: 's2', text: 'Part I'}],
    quotations: [{segment: 's4', starts_with: 'the people', end_segment: 's4', ends_with: 'is clear,', source: 'Times'}],
  }, wk.transcript, wk.flags);
  assert.equal(placed.picks.f1.choice, 'whisper');
  assert.equal(placed.edits.length, 2);
  assert.equal(placed.dropped.edits, 2);
  assert.equal(placed.edits[1].text, 'The court');
  // "November 2," keeps its comma: the find ended inside the word.
  assert.equal(placed.edits[0].text, 'Nov. 2,');
  assert.equal(placed.quotations.length, 1);
  assert.equal(placed.headings[0].w, wk.transcript.segments[1].w0);
});

test('nothing changes until it is decided, and decisions build the text', () => {
  const wk = work();
  wk.claude = placeResult({
    flags: [{id: 'f1', choice: 'whisper', text: 'blockers', confidence: 'high', reason: 'Medical term.'}],
    edits: [{segment: 's3', find: 'the court', replace: 'The court', kind: 'style', reason: 'A sentence begins here.'}],
    paragraphs: ['s1', 's3'], headings: [{segment: 's2', text: 'Part I'}], quotations: [],
  }, wk.transcript, wk.flags);
  const review = emptyReview();
  assert.deepEqual(progress(wk, review), {done: 0, total: 3});
  const before = assemble(wk, review);
  assert.match(before[0].text, /puberty walkers/);
  assert.match(before[1].text, /^the court/);
  assert.equal(before.length, 2);

  review.flags.f1 = {choice: 'claude'};
  review.edits.e1 = 'accepted';
  review.headings.h1 = 'accepted';
  const after = assemble(wk, review);
  assert.deepEqual(after.map(b => b.type), ['p', 'heading', 'p', 'p']);
  assert.equal(after[0].text, "It's Monday, November 2, 2026.");
  assert.equal(after[1].text, 'Part I');
  assert.match(after[2].text, /puberty blockers and/);
  assert.match(after[3].text, /^The court will hear/);
  assert.deepEqual(progress(wk, review), {done: 3, total: 3});

  review.flags.f1 = {choice: 'custom', text: 'puberty-blocking drugs'};
  assert.match(assemble(wk, review)[2].text, /use of puberty puberty-blocking drugs and/);
  assert.deepEqual(items(wk).map(i => i.type), ['heading', 'flag', 'edit']);
});

test('the matcher agrees with Python difflib', {skip: !hasPython()}, () => {
  let seed = 7;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const cases = Array.from({length: 40}, () => {
    const vocab = ['a', 'b', 'c', 'd', 'e', 'the', 'of'];
    const a = Array.from({length: 20 + rand(60)}, () => vocab[rand(vocab.length)]);
    const b = a.filter(() => rand(10) > 1).map(x => rand(12) ? x : vocab[rand(vocab.length)]);
    return [a, b];
  });
  const py = JSON.parse(execFileSync('python3', ['-I', '-c', `
import difflib, json, sys
cases = json.load(sys.stdin)
print(json.dumps([[list(map(list, difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes())),
                   round(difflib.SequenceMatcher(None, a, b, autojunk=False).ratio(), 10)] for a, b in cases]))
`], {input: JSON.stringify(cases)}).toString());
  cases.forEach(([a, b], k) => {
    const sm = SM(a, b);
    assert.deepEqual(sm.opcodes(), py[k][0]);
    assert.equal(+sm.ratio().toFixed(10), py[k][1]);
  });
});

function hasPython() {
  try { execFileSync('python3', ['-I', '-c', 'pass']); return true; } catch { return false; }
}

// ---------------------------------------------------------------- speakers

const {turns, speakerName} = require('../src/core/review');

// A conversation: MacWhisper puts a speaker on each segment.
function conversation() {
  const raw = asr([
    'This is the program, and I am your host.',
    'My guest wrote a book about families, and welcome.',
    'It is great to be here.',
    'Tell me why you wrote it.',
    'Well it came out of many conversations.',
    'That is fascinating to hear.',
  ]);
  ['Speaker 1', 'Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2', 'Speaker 2'].forEach((s, k) => { raw.segments[k].speaker = s; });
  const p = readAsr(raw);
  return {transcript: p, flags: [], claude: {}};
}

test('voices are read from the segments, and a single voice is not a conversation', () => {
  const wk = conversation();
  assert.deepEqual(wk.transcript.speakers.map(s => s.label), ['Speaker 1', 'Speaker 2']);
  assert.deepEqual(readAsr(P).speakers, []);
});

test('speaker names and corrected turns shape the transcript only once accepted', () => {
  const wk = conversation();
  wk.claude = placeResult({flags: [], edits: [], paragraphs: [], headings: [], quotations: [],
    speakers: [{label: 'Speaker 1', name: 'Alicia Keller', reason: 'He introduces himself as host.'},
               {label: 'Speaker 2', name: 'Jane Guest', reason: 'Introduced as the guest.'},
               {label: 'Speaker 9', name: 'Nobody', reason: 'No such voice.'}],
    speaker_fixes: [{segment: 's6', speaker: 'Speaker 1', reason: 'The host reacts to the answer.'},
                    {segment: 's2', speaker: 'Speaker 1', reason: 'Already Speaker 1.'}]}, wk.transcript, wk.flags);
  assert.equal(wk.claude.speakers.length, 2);
  assert.equal(wk.claude.speakerFixes.length, 1);
  assert.deepEqual(items(wk).map(i => i.type), ['names', 'turn']);

  const review = emptyReview();
  const labels = blocks => blocks.filter(b => b.type === 'speaker').map(b => b.text);
  assert.deepEqual(labels(assemble(wk, review)), ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2']);
  review.names.n1 = 'accepted';
  review.turns.t1 = 'accepted';
  review.speakers['Speaker 2'] = 'Noelle Ferris';
  assert.equal(speakerName(wk, review, 'Speaker 1'), 'Alicia Keller');
  const out = assemble(wk, review);
  assert.deepEqual(labels(out), ['Alicia Keller', 'Noelle Ferris', 'Alicia Keller', 'Noelle Ferris', 'Alicia Keller']);
  assert.equal(out[out.length - 1].text, 'That is fascinating to hear.');
  assert.equal(turns(wk, review).length, 5);
});

// ---------------------------------------------------------------- the word list

const {matches, addWord, clean} = require('../src/core/wordlist');

test('the word list corrects every misheard form, and "every time" entries need no review', () => {
  const raw = asr([
    "I'm Alicia Kellar, and this is the bulletin.",
    "Kellar's point was that Robert Koehler testified.",
    'The walkers were mentioned.',
  ]);
  const p = readAsr(raw);
  const wk = {transcript: p, flags: [{id: 'f1', w1: p.segments[2].w0 + 1, w2: p.segments[2].w0 + 2, at: 1, end: 2, parakeet: 'walkers', whisper: 'blockers'}],
    claude: {edits: [{id: 'e1', w1: 2, w2: 3, at: 0, end: 1, text: 'Keller,', kind: 'word', reason: 'Name.'}]},
    wordList: [{write: 'Keller', heard: ['Kellar'], always: true}, {write: 'puberty blockers', heard: ['walkers']},
               {write: 'Robert Koehler', heard: ['Robert Kelner'], always: false}]};
  const m = matches(wk);
  // Kellar twice (one possessive); the flagged "walkers" is left to the flag.
  assert.deepEqual(m.map(x => x.text), ['Keller,', "Keller's"]);
  assert.ok(m.every(x => x.always && x.id.startsWith('L')));
  // The list's correction replaces Claude's edit on the same word, and counts as done.
  const list = items(wk);
  assert.equal(list.filter(i => i.type === 'edit').length, 2);
  const review = emptyReview();
  assert.deepEqual(progress(wk, review), {done: 2, total: 3});
  const text = () => assemble(wk, review).map(b => b.text).join(' ');
  assert.match(text(), /^I'm Alicia Keller, and this is the bulletin\. Keller's point was that Robert Koehler testified\./);
  // Skipping one puts the heard form back.
  review.edits[m[1].id] = 'skipped';
  assert.match(text(), /bulletin\. Kellar's point/);
});

test('a correction from review folds into the entry for the same spelling', () => {
  let list = addWord([], {write: 'Keller.', heard: 'Kellar,'});
  list = addWord(list, {write: 'Keller', heard: 'Kelner'});
  list = addWord(list, {write: 'Keller', heard: 'keller'});
  assert.deepEqual(clean(list), [{write: 'Keller', heard: ['Kellar', 'Kelner'], always: true, note: ''}]);
});

test('a spelling can go on the list by itself, an ordinary word is only suggested, and a plural apostrophe is dropped', () => {
  // A spelling with nothing misheard is kept, for the engines and Claude.
  let list = addWord([], {write: 'Keller', heard: []});
  assert.deepEqual(clean(list), [{write: 'Keller', heard: [], always: true, note: ''}]);
  const {glossary} = require('../src/core/wordlist');
  assert.equal(glossary(list), 'Keller');
  // An ordinary word added to a name's entry makes the entry a suggestion.
  list = addWord([], {write: 'Joyce', heard: ['Joice']});
  list = addWord(list, {write: 'Joyce', heard: ['joys'], always: false});
  assert.deepEqual(clean(list), [{write: 'Joyce', heard: ['Joice', 'joys'], always: false, note: ''}]);

  const p = readAsr(asr(["Ask whether the joys' list can grow."]));
  const m = matches({transcript: p, flags: [], wordList: list});
  assert.deepEqual(m.map(x => [x.text, x.always]), [['Joyce', false]]);
});

test('the word list settles a disagreement about a listed name, but only decides it when the name is all that differs', () => {
  const {flagPick} = require('../src/core/wordlist');
  const list = [{write: 'Ferris', heard: ['Faris', 'Pharis']}, {write: 'El-Sayed', heard: ['Sayyid']}];
  const auto = flagPick({parakeet: 'Faris,', whisper: 'Pharis,'}, list);
  assert.deepEqual([auto.text, auto.auto], ['Ferris,', true]);
  const partial = flagPick({parakeet: 'Abdullah Sayyid,', whisper: 'Abdul Asayyad,'}, list);
  assert.deepEqual([partial.text, partial.auto], ['Abdullah El-Sayed,', false]);
  assert.equal(flagPick({parakeet: 'walkers', whisper: 'blockers'}, list), null);

  const wk = work();
  wk.wordList = [{write: 'blockers', heard: ['walkers']}];
  const review = emptyReview();
  assert.match(assemble(wk, review)[0].text, /puberty blockers and/);   // decided by the list
  review.flags.f1 = {choice: 'parakeet'};
  assert.match(assemble(wk, review)[0].text, /puberty walkers and/);    // the person overruled it
});

test("your own edits replace whatever else is on those words and are in the export", () => {
  const wk = work();
  wk.claude = placeResult({flags: [{id: 'f1', choice: 'whisper', text: 'blockers', confidence: 'high', reason: 'x', evidence: []}],
    edits: [], paragraphs: [], headings: [], quotations: []}, wk.transcript, wk.flags);
  const f = wk.flags[0];
  const review = {...emptyReview(), manual: [{id: 'm1', w1: f.w1 - 1, w2: f.w2 + 1, text: 'puberty-blocking drugs and', at: 1, end: 2}]};
  const list = items(wk, review);
  assert.ok(!list.some(i => i.id === 'f1'), 'the flag under the edit is gone');
  assert.ok(list.some(i => i.id === 'm1' && i.source === 'staff'));
  assert.deepEqual(progress(wk, review), {done: 1, total: 1});
  assert.match(assemble(wk, review).map(b => b.text).join(' '), /the use of puberty-blocking drugs and other treatments/);
});

test('the engines hear every entry as a prompt, and only sure entries and the speakers are boosted', () => {
  const {vocabulary} = require('../src/core/wordlist');
  const v = vocabulary([{write: 'Keller', heard: ['Kellar']}, {write: 'Joyce', heard: ['joys'], always: false}, {write: 'Al', heard: []}],
    ['Alicia Keller']);
  assert.equal(v.prompt, 'Keller, Joyce, Al, Alicia Keller.');
  // "joys" must stay a suggestion, and a term too short to spot is left to Whisper.
  assert.deepEqual(v.terms, [{text: 'Keller', aliases: ['Kellar']}, {text: 'Alicia Keller', aliases: []}]);
  assert.deepEqual(vocabulary([], []), {prompt: '', terms: []});
  // A long list keeps its newest entries and the speakers, the end Whisper reads.
  const many = Array.from({length: 80}, (_, i) => ({write: `Name${i}`, heard: []}));
  const p = vocabulary(many, ['Alicia Keller']).prompt;
  assert.ok(p.length <= 381 && p.endsWith('Name79, Alicia Keller.') && !p.includes('Name0,'));
});

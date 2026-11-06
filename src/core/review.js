// The review: every flag, suggested edit, heading and speaker question as one ordered list of items, the
// text each decision puts in place, and the finished transcript. Unreviewed items change nothing.

const {matches, flagPick} = require('./wordlist');

const ORDER = {names: 0, heading: 1, turn: 2, flag: 3, edit: 3, quote: 4};
const KEYS = {flag: 'flags', edit: 'edits', heading: 'headings', names: 'names', turn: 'turns', quote: 'quotes'};
const overlaps = (a, b) => a.w1 < b.w2 && b.w1 < a.w2;

// The person's own edits, made by selecting words in the transcript. They replace anything else on those words.
function manualItems(review) {
  return (review?.manual || []).filter(m => m.w2 > m.w1).map(m => ({id: m.id, type: 'edit', source: 'staff', kind: 'yours',
    w1: m.w1, w2: m.w2, at: m.at ?? 0, end: m.end ?? m.at ?? 0, text: m.text, reason: 'Your edit.'}));
}

// The article's words a quote check put in, one edit per place, kept with the quote's decision. Like the person's
// own edits they replace whatever else is on those words, so each one's text already carries those changes.
function quoteFixItems(review) {
  const out = [];
  for (const [qid, d] of Object.entries(review?.quotes || {})) {
    if (d?.choice !== 'article') continue;
    for (const f of d.fixes || []) {
      if (f.w2 > f.w1) out.push({id: f.id, type: 'edit', source: 'quote', kind: 'quote', quote: qid, w1: f.w1, w2: f.w2,
        at: f.at ?? 0, end: f.end ?? f.at ?? 0, text: f.text, reason: 'The article’s words, from the quote check.'});
    }
  }
  return out;
}

// One quote check as a review item, from the result src/core/quotes.js gives. It sits after the changes
// inside its passage, since it reads the passage as they leave it.
const quoteItem = (c, words) => ({...c, type: 'quote', at: c.at ?? words[c.w1]?.s ?? 0,
  end: words[Math.max(c.w1, c.w2 - 1)]?.e ?? c.at ?? 0});
const position = it => (it.type === 'quote' ? it.w2 - 0.5 : it.w1);

// Everything to review apart from the quote checks: what decides the words of the transcript.
function baseItems(work, review = {}) {
  const {flags = [], claude = {}} = work;
  const picks = claude.picks || {};
  // The word list's corrections take the place of any Claude edit on the same words.
  const listed = matches(work);
  const clear = e => !listed.some(l => e.w1 < l.w2 && l.w1 < e.w2);
  const fixes = quoteFixItems(review);
  const mine = [...manualItems(review).filter(m => !fixes.some(f => overlaps(f, m))), ...fixes];
  // An insertion where one of the quote check's edits begins is inside it: that edit's text includes it.
  const free = it => !mine.some(m => (it.w2 > it.w1 ? overlaps(it, m)
    : (m.source === 'quote' ? m.w1 <= it.w1 : m.w1 < it.w1) && it.w1 < m.w2));
  const out = [
    ...(claude.speakers?.length ? [{id: 'n1', type: 'names', w1: 0, w2: 0, at: 0, names: claude.speakers}] : []),
    ...flags.map(f => ({...f, type: 'flag', pick: picks[f.id] || null, listPick: flagPick(f, work.wordList)})),
    ...(claude.edits || []).filter(clear).map(e => ({...e, type: 'edit'})),
    ...listed.map(e => ({...e, type: 'edit'})),
    ...(claude.headings || []).map((h, i) => ({id: `h${i + 1}`, type: 'heading', w1: h.w, w2: h.w, text: h.text,
      at: work.transcript.words[h.w]?.s ?? 0})),
    ...(claude.speakerFixes || []).map(t => ({...t, type: 'turn'})),
  ].filter(it => it.type === 'names' || free(it));
  out.push(...mine);
  return out;
}

// Every item in reading order, with its group. The quote checks come from work.quoteChecks, the results
// src/core/quotes.js gives for the passages read aloud, when the caller has them.
function items(work, review = {}) {
  const {words} = work.transcript;
  const out = [...baseItems(work, review), ...(work.quoteChecks || []).map(c => quoteItem(c, words))];
  return out.sort((x, y) => position(x) - position(y) || ORDER[x.type] - ORDER[y.type]).map(it => ({...it, group: groupOf(it, words)}));
}

// ---- groups: how the Changes tab sorts the items, so a reviewer can take the mechanical ones at once and
// listen to the rest. Decided by what an edit does to the words, not by the label Claude gave it.

const GROUPS = ['stutters', 'punctuation', 'style', 'quotations', 'corrections', 'hearing', 'quotes', 'structure', 'list', 'yours'];
const STUTTER = /stutter|repeat|false start|restart|filler/i;
const toks = s => String(s || '').toLowerCase().replace(/’/g, "'").split(/[^\p{L}\p{N}']+/u).filter(Boolean);
const letters = s => String(s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const marks = s => (String(s || '').match(/[“”‘]/g) || []).length;

// The words of a that b leaves out, when b is a with words only taken away; null when b adds or changes any.
function dropped(a, b) {
  const out = [];
  let j = 0;
  for (const t of a) { if (j < b.length && t === b[j]) j++; else out.push(t); }
  return j === b.length ? out : null;
}

function groupOf(it, words) {
  if (it.type === 'quote' || it.source === 'quote') return 'quotes';
  if (it.type === 'flag') return 'hearing';
  if (it.type !== 'edit') return 'structure';
  if (it.source === 'staff') return 'yours';
  if (it.source === 'list') return 'list';
  const kept = words.slice(it.w1, it.w2).filter(w => !w.filler);
  const was = kept.map(w => w.text).join(' '), now = it.text || '';
  // Marks added around a reading, or the spoken "quote" taken out.
  if (it.kind === 'quotation' || marks(now) > marks(was) || (/\bquote\b/i.test(was) && !/\bquote\b/i.test(now))) return 'quotations';
  if (letters(was) === letters(now)) return 'punctuation';
  // Words only taken out, each one repeated close by ("I I think", "th- the") or a false start or filler
  // Claude names as one. A split abbreviation being joined ("U." "S.") is style.
  const gone = dropped(toks(was), toks(now));
  if (gone?.length && !/^(\p{L}\.\s*)+$/u.test(was)) {
    const near = [...toks(now), ...words.slice(it.w2).filter(w => !w.filler).slice(0, 12).flatMap(w => toks(w.text))];
    const repeats = gone.every(t => near.some(n => n === t || n.startsWith(t)));
    if (repeats || STUTTER.test(it.reason || '')) return 'stutters';
  }
  // A word Claude thinks the engines misheard ("Macon" for Makin) changes what was said: never with the style.
  return it.kind === 'word' ? 'corrections' : 'style';
}

// The text a decision puts in place of words w1..w2, or null if the words stay as they are.
function resolution(item, decision) {
  if (!decision) return null;
  if (item.type === 'flag') {
    if (decision.choice === 'whisper') return item.whisper;
    if (decision.choice === 'claude') return item.pick ? item.pick.text : null;
    if (decision.choice === 'list') return item.listPick ? item.listPick.text : null;
    if (decision.choice === 'custom') return decision.text ?? '';
    return null;
  }
  if (item.type === 'edit') return decision === 'accepted' ? item.text : null;
  return null;
}

function isDone(item, decision) {
  if (item.type === 'flag' || item.type === 'quote') return Boolean(decision && decision.choice);
  return decision === 'accepted' || decision === 'skipped';
}

// An "every time" word-list correction counts as accepted until someone skips it, and so do the person's own
// edits and the article's words a quote check put in.
const decisionFor = (review, item) => review[KEYS[item.type]]?.[item.id] ??
  (item.source === 'staff' || item.source === 'quote' || (item.source === 'list' && item.always) ? 'accepted'
    : item.listPick?.auto ? {choice: 'list'} : undefined);

// ---- speakers

const isConversation = work => (work.transcript.speakers || []).length >= 2;

// What to print for a voice: the name the person gave it, Claude's once they accepted the names, or the label.
function speakerName(work, review, label) {
  if (review.speakers?.[label]) return review.speakers[label];
  if (review.names?.n1 === 'accepted') {
    const v = (work.claude?.speakers || []).find(s => s.label === label);
    if (v) return v.name;
  }
  return label;
}

// The voice of each segment, after the corrections the person accepted. A segment with no label keeps the voice
// before it. Empty for a recording with one voice.
function segmentSpeakers(work, review) {
  if (!isConversation(work)) return [];
  const fixes = new Map((work.claude?.speakerFixes || []).filter(t => review.turns?.[t.id] === 'accepted').map(t => [t.seg, t.to]));
  let last = null;
  return work.transcript.segments.map(seg => (last = fixes.get(seg.id) || seg.speaker || last));
}

// Where each speaker's turn begins: {w, label}.
function turns(work, review) {
  const labels = segmentSpeakers(work, review);
  const out = [];
  work.transcript.segments.forEach((seg, k) => { if (labels[k] && labels[k] !== labels[k - 1]) out.push({w: seg.w0, label: labels[k]}); });
  return out;
}

// Claude can only start a paragraph where an engine segment starts, and segments sometimes split a
// sentence ("Something that simply" | "What" | "needs to be noted…"). A break that already reads as the
// start of a sentence stays: after a finished sentence (um and uh aside), after one of Claude's edits that
// closes a phrase, at a change of voice, or on a common word written with a capital ("Yeah," "What").
// Any other moves to the nearest word after a finished sentence, or to such a capital a word or three away.
const ENDS = /[.?!—–]["”’)]*$/;
function snapper(work) {
  const {words, segments = []} = work.transcript;
  const closes = new Set((work.claude?.edits || []).filter(e => ENDS.test(e.text)).map(e => e.w2));
  const turns = new Set(segments.filter((s, k) => k > 0 && s.speaker && s.speaker !== segments[k - 1].speaker).map(s => s.w0));
  const bare = t => String(t || '').replace(/[^\p{L}'’]/gu, '');
  const lower = new Set(words.map(w => bare(w.text)).filter(t => t && t === t.toLowerCase()));
  const before = i => { let j = i - 1; while (j >= 0 && words[j].filler) j--; return j; };
  const ended = i => { const j = before(i); return j < 0 || ENDS.test(words[j].text) || closes.has(j + 1) || closes.has(i); };
  const capital = i => { const t = bare(words[i]?.text); return /^\p{Lu}/u.test(t) && !/^I(['’]|$)/.test(t) && lower.has(t.toLowerCase()); };
  const near = (w, test, reach) => {
    for (let d = 1; d <= reach; d++) {
      if (w - d > 0 && test(w - d)) return w - d;
      if (w + d < words.length && test(w + d)) return w + d;
    }
    return null;
  };
  return w => {
    if (w <= 0 || w >= words.length || ended(w) || turns.has(w) || capital(w)) return w;
    const a = near(w, ended, 12), b = near(w, capital, 3);
    const far = x => (x === null ? Infinity : Math.abs(x - w));
    return (far(b) < far(a) ? b : a) ?? w;
  };
}

// Where paragraphs begin: Claude's breaks, or when Claude has not said, a pause after a finished sentence or
// six sentences without one. Then the person's own: review.paragraphs {add: [w], remove: [w]}.
function paragraphStarts(work, review) {
  let out;
  if (work.claude?.paragraphs?.length) {
    const snap = snapper(work);
    out = new Set(work.claude.paragraphs.map(snap));
  } else {
    const {words, segments} = work.transcript;
    out = new Set();
    let run = 0;
    segments.forEach((seg, k) => {
      const prev = segments[k - 1];
      const ended = !prev || /[.?!]["”’)]?$/.test(words[prev.w1 - 1].text);
      const gap = prev ? seg.start - prev.end : Infinity;
      if (ended && (gap > 1.2 || run >= 6)) { out.add(seg.w0); run = 0; }
      run++;
    });
  }
  for (const w of review?.paragraphs?.remove || []) out.delete(w);
  for (const w of review?.paragraphs?.add || []) out.add(w);
  return out;
}

// The finished text as pieces, each tagged with the word it starts at, plus headings.
function pieces(work, review) {
  const {words} = work.transcript;
  const swaps = new Map(), inserts = new Map(), heads = new Map();
  const inside = w => [...swaps.entries()].some(([a, s]) => a < w && w < s.w2);
  const list = baseItems(work, review).sort((x, y) => x.w1 - y.w1 || ORDER[x.type] - ORDER[y.type]);
  for (const it of list) {
    const d = decisionFor(review, it);
    if (it.type === 'heading') {
      if (d === 'accepted') heads.set(it.w1, [...(heads.get(it.w1) || []), it.text]);
      continue;
    }
    const text = resolution(it, d);
    if (text === null) continue;
    if (it.w1 === it.w2) {
      if (!inside(it.w1)) inserts.set(it.w1, [...(inserts.get(it.w1) || []), text]);
      continue;
    }
    // Overlapping changes: the first in reading order wins.
    if ([...swaps.entries()].some(([a, s]) => a < it.w2 && it.w1 < s.w2)) continue;
    swaps.set(it.w1, {w2: it.w2, text});
  }
  const out = [];
  for (let i = 0; i <= words.length; i++) {
    for (const t of inserts.get(i) || []) if (t) out.push({w: i, text: t, ins: true});
    if (i === words.length) break;
    const s = swaps.get(i);
    if (s) { if (s.text) out.push({w: i, text: s.text, to: s.w2}); i = s.w2 - 1; continue; }
    if (words[i].filler) continue;
    out.push({w: i, text: words[i].text});
  }
  return {out, heads};
}

const join = parts => parts.join(' ').replace(/\s+/g, ' ').trim();

// Headings, speaker names and paragraphs with every decided change applied.
function assemble(work, review) {
  const {out, heads} = pieces(work, review);
  const starts = paragraphStarts(work, review);
  const turnAt = new Map(turns(work, review).map(t => [t.w, t.label]));
  const blocks = [];
  let cur = [];
  const flush = () => { const t = join(cur); if (t) blocks.push({type: 'p', text: t}); cur = []; };
  let next = 0;
  const marks = [...new Set([...starts, ...heads.keys(), ...turnAt.keys()])].sort((a, b) => a - b);
  for (const p of out) {
    // A change that swallowed a paragraph start still breaks the paragraph where it began.
    while (next < marks.length && marks[next] <= p.w) {
      flush();
      for (const h of heads.get(marks[next]) || []) blocks.push({type: 'heading', text: h});
      if (turnAt.has(marks[next])) blocks.push({type: 'speaker', text: speakerName(work, review, turnAt.get(marks[next]))});
      next++;
    }
    cur.push(p.text);
  }
  flush();
  return blocks;
}

// The finished text of words w1..w2, for checking a quotation against its source.
function spanText(work, review, w1, w2) {
  return join(pieces(work, review).out.filter(p => p.w >= w1 && p.w < w2).map(p => p.text));
}

// The pieces of the finished text that touch words w1..w2, a change that runs into the passage from before it
// included ("said, quote, let's" made "said, “Let’s"): {w, to, text, ins}. An insertion before word w1 counts.
function spanPieces(work, review, w1, w2) {
  return pieces(work, review).out
    .filter(p => (p.ins ? w1 <= p.w && p.w < w2 : p.w < w2 && (p.to ?? p.w + 1) > w1))
    .map(p => ({...p, text: join([p.text])}))
    .filter(p => p.text);
}

function progress(work, review) {
  const list = items(work, review);
  const done = list.filter(it => isDone(it, decisionFor(review, it))).length;
  return {done, total: list.length};
}

const emptyReview = () => ({flags: {}, edits: {}, headings: {}, names: {}, turns: {}, speakers: {}, quotes: {}});

// New suggestions from Claude replace the old ones, so every decision about the old ones goes with them: a
// flag settled with Claude's reading, and Claude's edits, headings, names and speaker checks. The person's
// own choices stay (an engine's reading, their own words, their edits, the names they typed).
function withoutAi(review = {}) {
  const r = {...emptyReview(), ...review};
  return {...r,
    flags: Object.fromEntries(Object.entries(r.flags).filter(([, d]) => d?.choice !== 'claude')),
    edits: Object.fromEntries(Object.entries(r.edits).filter(([id]) => !/^e\d+$/.test(id))),
    headings: {}, names: {}, turns: {}};
}

module.exports = {items, baseItems, resolution, isDone, decisionFor, paragraphStarts, isConversation, speakerName, segmentSpeakers, turns,
  assemble, spanText, spanPieces, progress, emptyReview, withoutAi, GROUPS, groupOf};

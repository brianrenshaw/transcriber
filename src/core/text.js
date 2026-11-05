// Words, tokens and the small vocabularies the comparison uses. Ported from the shadow test's
// shadow.py so the app classifies differences the same way the study did.

const WORD = /[A-Za-z0-9À-ɏ]+(?:['’][A-Za-z]+)?%?/g;

const fold = s => s.normalize('NFKC').replace(/[’‘‛]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[  ]/g, ' ');

// Lowercased word tokens with their character offsets and lengths in the original text: [token, at, length].
function toks(text) {
  const out = [];
  for (const m of text.matchAll(WORD)) {
    const w = fold(m[0]).toLowerCase(), n = m[0].length;
    if (w.endsWith('%')) { out.push([w.slice(0, -1), m.index, n - 1]); out.push(['percent', m.index + n - 1, 1]); }
    else out.push([w, m.index, n]);
  }
  return out;
}

// Sounds the published transcripts never print. They keep their timings but leave the text.
const DISFLUENT = new Set(['uh', 'um', 'uhh', 'umm', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']);
const isFiller = text => { const t = toks(text).map(x => x[0]); return t.length > 0 && t.every(x => DISFLUENT.has(x)); };

const FILLERS = new Set(['and', 'so', 'now', 'okay', 'ok', 'well', 'yeah', 'yes', 'um', 'uh', 'oh', 'just', 'you', 'know', 'kind',
  'of', 'like', 'right', 'all', 'i', 'mean', 'the', 'a', 'that', 'but', 'again', 'er', 'ah', 'hmm', 'mm']);

const CONTRACTIONS = {
  gonna: 'going to', wanna: 'want to', gotta: 'got to', kinda: 'kind of', sorta: 'sort of', alright: 'all right',
  "would've": 'would have', "could've": 'could have', "should've": 'should have', "it's": 'it is', "that's": 'that is',
  "i'll": 'i will', "we're": 'we are', "they're": 'they are', "you've": 'you have', "he's": 'he is', "she's": 'she is',
  "i'm": 'i am', "can't": 'can not', cannot: 'can not', "don't": 'do not', "isn't": 'is not', "doesn't": 'does not',
  "won't": 'will not', "let's": 'let us', "there's": 'there is', "what's": 'what is', "we've": 'we have', "i've": 'i have',
  "you're": 'you are', "they've": 'they have', "wouldn't": 'would not', "couldn't": 'could not', "shouldn't": 'should not',
  "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not', "haven't": 'have not', "hasn't": 'has not',
  "didn't": 'did not', "it'll": 'it will', "we'll": 'we will', "you'll": 'you will', "they'll": 'they will',
  "he'll": 'he will', "i'd": 'i would', "we'd": 'we would', "you'd": 'you would', "they'd": 'they would',
  "he'd": 'he would', "here's": 'here is', "who's": 'who is', "where's": 'where is', "how's": 'how is',
  plough: 'plow', archaeology: 'archeology', towards: 'toward', okay: 'ok', percent: '%', 'per cent': '%',
};

// Two token runs that say the same thing once contractions, compounds and spacing are folded away.
const canon = tokens => tokens.map(t => CONTRACTIONS[t] ?? t).join(' ').replace(/[ ']/g, '');

const NUMWORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion', 'trillion', 'percent',
  'first', 'second', 'third', 'fourth', 'fifth', 'point', 'and', 'dollars', 'a']);
const DECADES = new Set(['twenties', 'thirties', 'forties', 'fifties', 'sixties', 'seventies', 'eighties', 'nineties', 'hundreds']);
const ORDINALS = new Set(['twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth',
  'hundredth', 'thousandth', 'eighth', 'ninth', 'twelfth']);

function isNumberish(tokens) {
  const num = t => {
    const base = t.replace(/(ieth|th|st|nd|rd)$/, '');
    return /^\d+$/.test(t) || NUMWORDS.has(t) || DECADES.has(t) || /^\d+(st|nd|rd|th|s|'s)$/.test(t) ||
      NUMWORDS.has(base) || NUMWORDS.has(base + 'y') || ORDINALS.has(t);
  };
  return tokens.length > 0 && tokens.every(num);
}

// MacWhisper JSON (times in milliseconds) as display words, segments and comparison tokens.
// A piece that starts with a space begins a word; any other piece ("'s", "-off", ",") joins the one before.
function readAsr(raw) {
  const payload = typeof raw === 'string' ? JSON.parse(raw.slice(raw.indexOf('{'))) : raw;
  const words = [], segments = [];
  for (const seg of payload.segments || []) {
    const w0 = words.length;
    const pieces = seg.words?.length ? seg.words
      : (seg.text || '').trim().split(/\s+/).filter(Boolean).map(t => ({text: ' ' + t, start: seg.start, end: seg.end}));
    // Some runs mark a new word with a leading space and some don't, so the segment's own text decides:
    // a piece that follows a space there begins a word. A piece the text can't place falls back to its space.
    const segText = seg.text || '';
    let at = 0;
    for (const p of pieces) {
      const text = p.text || '', piece = text.trim();
      const s = (p.start ?? seg.start ?? 0) / 1000, e = (p.end ?? p.start ?? seg.end ?? 0) / 1000;
      if (!piece) continue;
      let gap = 0;
      while (at < segText.length && /\s/.test(segText[at])) { at++; gap++; }
      let fresh;
      if (segText.startsWith(piece, at)) { fresh = gap > 0 || at === 0; at += piece.length; }
      else fresh = /^\s/.test(text);
      const last = words[words.length - 1];
      if (fresh || words.length === w0 || !last) words.push({text: piece, s, e});
      else { last.text += piece; last.e = e; }
    }
    if (words.length > w0) {
      segments.push({id: `s${segments.length + 1}`, start: words[w0].s, end: words[words.length - 1].e, w0, w1: words.length,
        speaker: seg.speaker || null});
    }
  }
  for (const w of words) if (isFiller(w.text)) w.filler = true;
  const tokens = [];
  words.forEach((w, i) => { for (const [t] of toks(w.text)) tokens.push({t, w: i}); });
  return {words, segments, tokens, speakers: speakerList(segments)};
}

// The voices MacWhisper told apart, by share of the words. A label with under 3% of the words is noise
// (a cough, a clip played on air), so a recording is a conversation only when two voices clear that bar.
function speakerList(segments) {
  const n = new Map();
  let total = 0;
  for (const s of segments) { const k = s.speaker; const c = s.w1 - s.w0; total += c; if (k) n.set(k, (n.get(k) || 0) + c); }
  const list = [...n.entries()].map(([label, words]) => ({label, words, share: total ? words / total : 0}))
    .filter(s => s.share >= 0.03).sort((a, b) => b.words - a.words);
  return list.length >= 2 ? list : [];
}

const clock = sec => {
  const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s % 60).padStart(2, '0')}`;
};

module.exports = {WORD, fold, toks, FILLERS, DISFLUENT, isFiller, canon, isNumberish, readAsr, speakerList, clock};

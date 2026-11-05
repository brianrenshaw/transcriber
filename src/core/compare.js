// Where Parakeet and Whisper heard different words. Parakeet's text is the base a person reviews;
// each place Whisper disagrees becomes a flag.

const {SM} = require('./sm');
const {FILLERS, DISFLUENT, canon, isNumberish} = require('./text');

const MERGE_GAP = 2;     // differences closer than this many matching tokens are one place to listen
const ANCHOR = 5;        // matching runs this long mark where both engines cover the recording
const QUOTE_WORDS = new Set(['quote', 'end', 'unquote', 'close', 'open']);
// Real words of one or two letters; any other token that short is a piece of a word.
const SHORT_WORDS = new Set(['a', 'i', 'an', 'am', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'my',
  'no', 'of', 'oh', 'ok', 'on', 'or', 'so', 'to', 'up', 'us', 'we', 'ye']);
// Words Whisper drops when it tidies conversational speech ("it, it was", "in in the"). Alone on one side
// they are not worth a listen.
const SMALL_WORDS = new Set(['it', "it's", 'in', 'we', "we're", 'if', 'on', 'an', 'to', 'of', 'is', "that's", 'then', 'when',
  'there', "there's", 'they', 'he', 'she', 'was', 'be', 'this', 'what', 'are', 'or', 'for', 'at', 'as', 'with', 'my', 'do']);

// A number or an acronym (NASA, CBS) is never a fragment, so only one or two letters, or the start of a
// word said just after, count.
const fragment = (t, ahead) => !/\d/.test(t) && ((t.length <= 2 && !SHORT_WORDS.has(t)) ||
  (t.length <= 7 && ahead.some(n => n.length > t.length && n.startsWith(t))));

// A run of tokens without the sounds of speaking: um and uh, a word said twice in a row, and a false start
// that the next word completes ("th there", "sev several").
function fluent(tokens, after = []) {
  const out = [];
  tokens.forEach((t, k) => {
    const ahead = [...tokens.slice(k + 1), ...after].slice(0, 3);
    if (DISFLUENT.has(t)) return;
    if (ahead[0] === t) return;
    if (fragment(t, ahead)) return;
    out.push(t);
  });
  return out;
}

// Why a difference needs no listening, or null if it does.
function ignorable(pt, wt, context, after = []) {
  if (pt.length && wt.length && canon(pt) === canon(wt)) return 'spelling or contraction';
  const pf = fluent(pt, after), wf = fluent(wt, after);
  if (canon(pf) === canon(wf)) return 'false start or repeat';
  if (isNumberish(pt) && isNumberish(wt)) return 'number format';
  const extra = pt.length ? (wt.length ? null : pt) : wt;
  if (extra) {
    if (extra.every(t => FILLERS.has(t))) return 'filler';
    if (extra.length === 1 && SMALL_WORDS.has(extra[0])) return 'small word';
    if (extra.every(t => QUOTE_WORDS.has(t))) return 'spoken quote mark';
    if (extra.every(t => context.has(t))) return 'repeated word';
  }
  return null;
}

const span = (words, w1, w2) => words.slice(w1, w2).map(w => w.text).join(' ');

// Each display word's first and last token.
function wordTokens(tokens) {
  const first = new Map(), last = new Map();
  tokens.forEach(({w}, k) => { if (!first.has(w)) first.set(w, k); last.set(w, k); });
  return {first, last};
}

// The engines are matched token by token, and a hyphen splits a word into tokens, so a difference can end
// inside a word on one side only: Parakeet "extension level", Whisper "extinction-level" differ only at
// "extension"/"extinction". Shown as whole words, Whisper's side would be "extinction-level" against
// Parakeet's "extension", and choosing it would print "extinction-level level". Widen both sides together
// until each covers whole words. The tokens taken in are ones the engines share, so they pair one for one.
function widen({i1, i2, j1, j2}, p, w, pt, wt) {
  for (let n = 0; n < 6; n++) {
    let moved = false;
    if (i2 > i1) {
      const lo = pt.first.get(p.tokens[i1].w), hi = pt.last.get(p.tokens[i2 - 1].w) + 1;
      if (lo < i1 || hi > i2) { j1 -= i1 - lo; j2 += hi - i2; i1 = lo; i2 = hi; moved = true; }
    }
    if (j2 > j1) {
      const lo = wt.first.get(w.tokens[j1].w), hi = wt.last.get(w.tokens[j2 - 1].w) + 1;
      if (lo < j1 || hi > j2) { i1 -= j1 - lo; i2 += hi - j2; j1 = lo; j2 = hi; moved = true; }
    }
    i1 = Math.max(0, i1); j1 = Math.max(0, j1); i2 = Math.min(p.tokens.length, i2); j2 = Math.min(w.tokens.length, j2);
    if (!moved) break;
  }
  return {i1, i2, j1, j2};
}

function compareEngines(p, w) {
  const a = p.tokens.map(x => x.t), b = w.tokens.map(x => x.t);
  const sm = SM(a, b);
  const blocks = sm.blocks();
  const matched = blocks.reduce((n, x) => n + x[2], 0);
  const anchors = blocks.filter(x => x[2] >= ANCHOR);
  const stats = {parakeetTokens: a.length, whisperTokens: b.length, agreement: a.length ? matched / a.length : 0, ignored: {}};
  if (!anchors.length) return {flags: [], stats};
  const a0 = anchors[0][0], b0 = anchors[0][1];
  const last = anchors[anchors.length - 1], a1 = last[0] + last[2], b1 = last[1] + last[2];

  // Differences, with near neighbours merged into one region.
  const regions = [];
  for (const [op, i1, i2, j1, j2] of sm.opcodes()) {
    if (op === 'equal') continue;
    if (i2 <= a0 && j2 <= b0) continue;             // before both engines settle in
    if (i1 >= a1 && j1 >= b1) continue;             // after the last stretch they share
    const prev = regions[regions.length - 1];
    if (prev && i1 - prev.i2 < MERGE_GAP && j1 - prev.j2 < MERGE_GAP) { prev.i2 = i2; prev.j2 = j2; }
    else regions.push({i1, i2, j1, j2});
  }

  // Whether a difference needs listening is judged on the tokens that differ; what is shown covers whole words.
  const pw = wordTokens(p.tokens), ww = wordTokens(w.tokens);
  const kept = [];
  for (const r of regions) {
    const pt = a.slice(r.i1, r.i2), wt = b.slice(r.j1, r.j2);
    const context = new Set([...a.slice(Math.max(0, r.i1 - 3), r.i1), ...a.slice(r.i2, r.i2 + 3)]);
    const why = ignorable(pt, wt, context, a.slice(r.i2, r.i2 + 3));
    if (why) { stats.ignored[why] = (stats.ignored[why] || 0) + 1; continue; }
    const x = widen(r, p, w, pw, ww);
    // Widened into the place before it: one place to listen.
    const prev = kept[kept.length - 1];
    if (prev && (x.i1 < prev.i2 || x.j1 < prev.j2)) { prev.i2 = Math.max(prev.i2, x.i2); prev.j2 = Math.max(prev.j2, x.j2); }
    else kept.push(x);
  }

  const flags = [];
  for (const {i1, i2, j1, j2} of kept) {
    // Token ranges to whole display words. An empty Parakeet side is an insertion before word w1.
    const pw1 = i2 > i1 ? p.tokens[i1].w : (i1 < p.tokens.length ? p.tokens[i1].w : p.words.length);
    const pw2 = i2 > i1 ? p.tokens[i2 - 1].w + 1 : pw1;
    const ww1 = j2 > j1 ? w.tokens[j1].w : null, ww2 = j2 > j1 ? w.tokens[j2 - 1].w + 1 : null;
    const at = i2 > i1 ? p.words[pw1].s : (ww1 !== null ? w.words[ww1].s : (p.words[pw1] || p.words[p.words.length - 1]).s);
    const end = i2 > i1 ? p.words[pw2 - 1].e : (ww2 !== null ? w.words[ww2 - 1].e : at);
    flags.push({
      id: `f${flags.length + 1}`, w1: pw1, w2: pw2, at, end,
      parakeet: span(p.words, pw1, pw2), whisper: ww1 === null ? '' : span(w.words, ww1, ww2),
    });
  }
  stats.flags = flags.length;
  return {flags, stats};
}

module.exports = {compareEngines, ignorable, fluent};

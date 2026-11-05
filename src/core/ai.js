// Placing an AI pass's answer on the transcript. The model never rewrites the text: it recommends a reading
// for each flag and proposes discrete edits, and this turns its structured answer into suggestions tied to
// word ranges. Every one of them waits for a person to accept or skip it. Nothing changes silently.
//
// The prompt and the provider (the person's own Claude Code sign-in, their API key, or none) live elsewhere;
// this file only knows the answer's shape.

const {clock} = require('./text');

// A segment as the model reads it: without um and uh, which never reach the page.
const segText = (words, seg) => words.slice(seg.w0, seg.w1).filter(w => !w.filler).map(w => w.text).join(' ');

// Character offsets of each word in a segment's text, as segText joins them.
function offsets(words, seg) {
  const out = [];
  let c = 0;
  for (let i = seg.w0; i < seg.w1; i++) {
    if (words[i].filler) continue;
    out.push([i, c, c + words[i].text.length]); c += words[i].text.length + 1;
  }
  return out;
}

const loose = s => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').toLowerCase();

// Find text in a segment: exact first, then ignoring case and quote styles.
function locate(words, seg, find) {
  const text = segText(words, seg);
  let c0 = find ? text.indexOf(find) : -1;
  if (c0 < 0 && find) c0 = loose(text).indexOf(loose(find));
  if (c0 < 0) return null;
  const c1 = c0 + find.length, offs = offsets(words, seg);
  const first = offs.find(([, , e]) => e > c0), lastW = [...offs].reverse().find(([, s]) => s < c1);
  if (!first || !lastW) return null;
  return {w1: first[0], w2: lastW[0] + 1, prefix: text.slice(first[1], c0), suffix: text.slice(c1, lastW[2])};
}

// The model's structured answer as suggestions tied to word ranges; anything that cannot be placed is dropped
// and counted, so the review screen can say so.
function placeResult(result, transcript, flags) {
  const {words, segments} = transcript;
  const segById = new Map(segments.map(s => [s.id, s]));
  const flagIds = new Set(flags.map(f => f.id));
  const taken = flags.filter(f => f.w2 > f.w1).map(f => [f.w1, f.w2]);
  const overlaps = (a, b) => taken.some(([x, y]) => a < y && x < b);
  const dropped = {edits: 0, quotations: 0};

  // A reason that slipped a segment id in gets the segment's time instead.
  const timed = s => String(s || '').replace(/\b(?:segment\s+)?s(\d+)\b/gi, (m, n) => {
    const seg = segById.get(`s${n}`);
    return seg ? clock(seg.start) : m;
  });
  const seconds = t => { const m = /^(?:(\d+):)?(\d+):(\d{2})$/.exec(String(t || '').trim()); return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] : null; };
  const picks = {};
  for (const f of result.flags || []) {
    if (!flagIds.has(f.id)) continue;
    const evidence = (f.evidence || []).filter(e => e.text && e.text.trim()).slice(0, 4)
      .map(e => ({kind: e.kind, text: timed(e.text).trim(), at: e.kind === 'recording' ? seconds(e.time) : null}));
    picks[f.id] = {choice: f.choice, text: f.text, confidence: f.confidence, reason: timed(f.reason), evidence};
  }

  const edits = [];
  for (const e of result.edits || []) {
    const seg = segById.get(e.segment);
    const at = seg && locate(words, seg, e.find);
    if (!at || overlaps(at.w1, at.w2)) { dropped.edits++; continue; }
    const text = at.prefix + e.replace + at.suffix;
    if (text === words.slice(at.w1, at.w2).filter(w => !w.filler).map(w => w.text).join(' ')) { dropped.edits++; continue; }
    taken.push([at.w1, at.w2]);
    edits.push({w1: at.w1, w2: at.w2, at: words[at.w1].s, end: words[at.w2 - 1].e, text, kind: e.kind, reason: timed(e.reason)});
  }
  edits.sort((x, y) => x.w1 - y.w1).forEach((e, k) => { e.id = `e${k + 1}`; });

  const paragraphs = [...new Set((result.paragraphs || []).map(id => segById.get(id)?.w0).filter(w => w !== undefined))]
    .sort((x, y) => x - y);
  const headings = (result.headings || []).filter(h => segById.has(h.segment) && h.text.trim())
    .map(h => ({w: segById.get(h.segment).w0, text: h.text.trim()}));

  // Names for the voices, and segments the model thinks were credited to the wrong one.
  const labels = new Set((transcript.speakers || []).map(v => v.label));
  const speakers = (result.speakers || []).filter(v => labels.has(v.label) && v.name.trim())
    .map(v => ({label: v.label, name: v.name.trim(), reason: timed(v.reason)}));
  const speakerFixes = [];
  for (const f of result.speaker_fixes || []) {
    const seg = segById.get(f.segment);
    if (!seg || !labels.has(f.speaker) || seg.speaker === f.speaker) { dropped.speakerFixes = (dropped.speakerFixes || 0) + 1; continue; }
    speakerFixes.push({w1: seg.w0, w2: seg.w0, at: seg.start, end: seg.end, seg: seg.id, from: seg.speaker, to: f.speaker, reason: timed(f.reason)});
  }
  speakerFixes.sort((x, y) => x.w1 - y.w1).forEach((f, k) => { f.id = `t${k + 1}`; });

  const quotations = [];
  for (const q of result.quotations || []) {
    const s1 = segById.get(q.segment), s2 = segById.get(q.end_segment);
    const a = s1 && locate(words, s1, q.starts_with), b = s2 && locate(words, s2, q.ends_with);
    if (!a || !b || b.w2 <= a.w1) { dropped.quotations++; continue; }
    quotations.push({id: `q${quotations.length + 1}`, w1: a.w1, w2: b.w2, at: words[a.w1].s, source: q.source || ''});
  }
  // A note's title and summary.
  const text = String(result.summary || '').trim();
  const summary = text ? {title: String(result.title || '').trim().replace(/^["“‘\s]+|["”’.\s]+$/g, ''), text: timed(text)} : null;
  return {picks, edits, paragraphs, headings, quotations, speakers, speakerFixes, dropped, ...(summary ? {summary} : {})};
}


module.exports = {placeResult, segText, locate};

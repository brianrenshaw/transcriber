// Your word list: how a name or term is written, and the ways the engines mishear it
// ("Keller", heard as Kellar, Kelner, Koehler). Each place a misheard form turns up becomes an edit.
// An entry marked "every time" is applied without asking and can still be undone; any other entry is
// suggested like Claude's edits. The list is matched afresh whenever a job opens, so a new entry reaches
// every transcript still on the desk.

const {toks} = require('./text');

// Entries as stored: {write, heard: [..], always}. Blank or duplicate forms are dropped. An entry with no
// misheard forms is a spelling to keep: the engines are told to listen for it, and Claude to write it so.
function clean(entries) {
  return (entries || []).map(e => ({
    write: String(e.write || '').trim(),
    heard: [...new Set((e.heard || []).map(h => String(h).trim()).filter(Boolean))],
    always: e.always !== false,
    note: String(e.note || '').trim(),
  })).filter(e => e.write);
}

// A word as a list form: no surrounding punctuation or quote marks, no possessive.
const bare = s => String(s).trim().replace(/^[“”"‘’'(\[]+|[“”"‘’')\].,;:!?]+$/g, '').replace(/['’]s$/i, '');

function matches(work) {
  const list = clean(work.wordList);
  if (!list.length) return [];
  const {words, tokens} = work.transcript;
  const seq = tokens.filter(t => !words[t.w].filler);
  const flagged = (work.flags || []).filter(f => f.w2 > f.w1).map(f => [f.w1, f.w2]);
  const taken = [];
  const free = (a, b) => ![...flagged, ...taken].some(([x, y]) => a < y && x < b);
  const out = [];
  list.forEach(entry => {
    for (const form of entry.heard) {
      const want = toks(form).map(t => t[0]);
      if (!want.length) continue;
      for (let k = 0; k + want.length <= seq.length; k++) {
        // The last word may carry a possessive: "Kellar's" is still "Kellar".
        const ok = want.every((t, j) => seq[k + j].t === t || (j === want.length - 1 && seq[k + j].t === `${t}'s`));
        if (!ok) continue;
        const w1 = seq[k].w, w2 = seq[k + want.length - 1].w + 1;
        if (!free(w1, w2)) continue;
        const first = words[w1].text, last = words[w2 - 1].text;
        const lead = /^[“"‘'(\[]*/.exec(first)[0];
        let tail = /(['’]s)?[”"’')\].,;:!?—]*$/i.exec(last)[0];
        // A plural possessive ("joys'") is the misheard word's own; the listed one takes no apostrophe of its own.
        if (/^['’](?!s)/i.test(tail) && !/s$/i.test(entry.write)) tail = tail.slice(1);
        const text = lead + entry.write + tail;
        if (text === words.slice(w1, w2).map(w => w.text).join(' ')) continue;
        taken.push([w1, w2]);
        out.push({w1, w2, at: words[w1].s, end: words[w2 - 1].e, text, kind: 'word list', source: 'list', always: entry.always,
          heard: form, write: entry.write,
          reason: `Word list: “${form}” is written “${entry.write}”.${entry.note ? ' ' + entry.note : ''}`});
        k += want.length - 1;
      }
    }
  });
  // Ids come from the position, so a decision stays with its place when entries are added or removed.
  return out.sort((x, y) => x.w1 - y.w1).map(m => ({...m, id: `L${m.w1}`}));
}

const tokensOf = s => toks(s).map(t => t[0]);
const contains = (seq, sub) => sub.length > 0 && seq.some((_, k) => k + sub.length <= seq.length &&
  sub.every((t, j) => seq[k + j] === t || (j === sub.length - 1 && seq[k + j] === `${t}'s`)));
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Text with a misheard form written the list's way, keeping punctuation and a possessive.
function rewrite(text, form, write) {
  const words = form.trim().split(/\s+/).map(esc).join('\\s+');
  return text.replace(new RegExp(`(^|[^A-Za-z0-9À-ɏ'’])(${words})(?=['’]s\\b|[^A-Za-z0-9À-ɏ'’]|$)`, 'i'), (m, pre) => pre + write);
}

// Where the engines disagree about a listed word: the reading the list gives. It decides the place by itself
// only for an "every time" entry and only when the listed word is the whole disagreement, so a word list
// entry can never quietly change the words around a name.
function flagPick(flag, entries) {
  const pt = tokensOf(flag.parakeet), wt = tokensOf(flag.whisper);
  for (const e of clean(entries)) {
    const wr = tokensOf(e.write);
    const whole = sub => (pt.length === sub.length && contains(pt, sub)) || (wt.length && wt.length === sub.length && contains(wt, sub));
    for (const form of e.heard) {
      const ft = tokensOf(form);
      const side = contains(pt, ft) ? flag.parakeet : contains(wt, ft) ? flag.whisper : null;
      if (side !== null) {
        return {text: rewrite(side, form, e.write), write: e.write, heard: form,
          auto: e.always && whole(ft) && (pt.length === wr.length || wt.length === wr.length), reason: `Word list: “${form}” is written “${e.write}”.`};
      }
    }
    // One engine already wrote it the list's way.
    if (contains(wt, wr) && !contains(pt, wr)) return {text: flag.whisper, write: e.write, heard: '', auto: e.always && wt.length === wr.length,
      reason: `Word list: Whisper has “${e.write}”, your spelling.`};
    if (contains(pt, wr) && !contains(wt, wr)) return {text: flag.parakeet, write: e.write, heard: '', auto: e.always && pt.length === wr.length,
      reason: `Word list: Parakeet has “${e.write}”, your spelling.`};
  }
  return null;
}

// Add a correction learned in review, folding it into an entry for the same written form. heard is one misheard
// form or several ("Kellar", "Kellor").
function addWord(entries, {write, heard, always = true}) {
  const w = bare(write);
  const list = clean(entries);
  const forms = [].concat(heard || []).map(bare).filter(hd => hd && hd.toLowerCase() !== w.toLowerCase());
  if (!w) return list;
  let same = list.find(e => e.write.toLowerCase() === w.toLowerCase());
  if (!same) { same = {write: w, heard: [], always, note: ''}; list.push(same); }
  // Changing every place without asking holds for all of an entry's forms, so an ordinary word added to it
  // makes the whole entry a suggestion.
  else if (always === false) same.always = false;
  for (const hd of forms) if (!same.heard.some(x => x.toLowerCase() === hd.toLowerCase())) same.heard.push(hd);
  return list;
}

// ---- learning names from review: the same name fixed twice is offered for the word list

// Words a transcript writes in lower case somewhere: ordinary words, whatever they start a sentence with.
const lowerForms = words => new Set((words || []).map(w => bare(w.text)).filter(t => t && t === t.toLowerCase()).map(t => t.toLowerCase()));

// A fix that writes a name or term: one of its words is capitalized, all letters, and never written in lower
// case in the transcript ("Keller", "Marta", "NBC"), unlike "There" at the start of a sentence or "U.S.".
const nameLike = (text, lower) => String(text || '').split(/\s+/).map(bare)
  .some(t => /^\p{Lu}[\p{L}'’-]+$/u.test(t) && !lower.has(t.toLowerCase()));

// The log of names fixed in review, by job and item, so a changed or undone decision replaces its own
// entry, plus the names the person said not to offer again: {fixes: {key: {write, heard: [..]}}, declined: [..]}.
function noteFix(log, key, fix) {
  const out = {fixes: {...(log?.fixes || {})}, declined: [...(log?.declined || [])]};
  delete out.fixes[key];
  if (fix) {
    const write = bare(fix.write);
    const heard = [...new Set([].concat(fix.heard || []).map(bare))].filter(hd => hd && hd.toLowerCase() !== write.toLowerCase());
    if (write && heard.length) out.fixes[key] = {write, heard};
  }
  return out;
}

const declineFix = (log, write) => ({fixes: {...(log?.fixes || {})}, declined: [...new Set([...(log?.declined || []), bare(write)])]});

// Once a name has been fixed twice, what to put on the word list: the misheard forms it lacks. Null while the
// name has one fix, when the list already has every form, or when the person said no.
function fixOffer(log, entries, write) {
  const k = bare(write || '').toLowerCase();
  if (!k || (log?.declined || []).some(d => d.toLowerCase() === k)) return null;
  const rows = Object.values(log?.fixes || {}).filter(f => f.write.toLowerCase() === k);
  if (rows.length < 2) return null;
  const listed = (clean(entries).find(e => e.write.toLowerCase() === k)?.heard || []).map(x => x.toLowerCase());
  const heard = [];
  for (const hd of rows.flatMap(r => r.heard)) {
    if (!listed.includes(hd.toLowerCase()) && !heard.some(x => x.toLowerCase() === hd.toLowerCase())) heard.push(hd);
  }
  return heard.length ? {write: rows[rows.length - 1].write, heard, times: rows.length} : null;
}

// What the speech engines are told to listen for, from the list and the people named as speaking.
// Whisper reads a prompt of how the names are written as though it were the text just before, so every entry
// goes in; it keeps about 110 tokens, the end of the prompt, so the newest entries and the people come last.
// Parakeet's boosting rewrites a word wherever a term is spelled like it and the audio fits, so it gets only
// the entries that change without asking, and the people: a suggestion like "joys" for "Joyce" must stay a
// suggestion, and Whisper writing "Joyce" against Parakeet's "joys" puts the place up for review.
const PROMPT_CHARS = 380;
function vocabulary(entries, people = []) {
  const list = clean(entries);
  const named = [].concat(people || []).map(p => bare(String(p))).filter(Boolean);
  const seen = new Set();
  const once = x => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; };
  const words = [...list.map(e => e.write), ...named].filter(once);
  while (words.length && words.join(', ').length > PROMPT_CHARS) words.shift();
  seen.clear();
  const terms = [...list.filter(e => e.always).map(e => ({text: e.write, aliases: e.heard})), ...named.map(text => ({text, aliases: []}))]
    .filter(t => t.text.replace(/[^\p{L}\p{N}]/gu, '').length >= 4 && once(t.text));
  return {prompt: words.length ? `${words.join(', ')}.` : '', terms};
}

// The list as Claude reads it.
function glossary(entries) {
  return clean(entries).map(e => `${e.write}${e.heard.length ? ` (heard as ${e.heard.join(', ')})` : ''}${e.note ? ` — ${e.note}` : ''}`).join('\n');
}

module.exports = {clean, matches, flagPick, rewrite, addWord, glossary, vocabulary, bare, lowerForms, nameLike, noteFix, declineFix, fixOffer};

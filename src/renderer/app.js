// The window: the list of transcripts, and the review screen synced to the audio.
// All work happens in the main process; this file renders what it sends and records the person's decisions.

const desk = window.desk;
const STEP_NAMES = {download: 'Downloading the recording', parakeet: 'Transcribing with Parakeet', whisper: 'Checking with Whisper',
  compare: 'Comparing the two'};
const STEP_ORDER = ['download', 'parakeet', 'whisper', 'compare'];
const AUDIO_EXT = /\.(mp3|m4a|wav|aac|aiff?|flac|ogg|opus|mp4|mov|m4v)$/i;

const state = {
  jobs: [], id: null, data: null, items: [], idx: 0, tab: 'transcript', view: 'job', notice: null,
  wordEl: [], stopAt: null, clip: null, mode: 'hear', owning: false, saving: null,
};

// ---------------------------------------------------------------- small helpers

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v;      // through the CSSOM, which the page's CSP allows
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const clock = sec => {
  const s = Math.max(0, Math.floor(sec || 0)), hh = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return (hh ? `${hh}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s % 60).padStart(2, '0')}`;
};
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const dateLabel = iso => new Date(iso).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
const kbd = k => h('kbd', {}, k);
// A rail button's key: named once in the help line under the card, and kept on the button as its tooltip.
const keyed = (el, k) => { el.title = `${el.textContent} (${k})`; return el; };
// Words as printed: um and uh keep their timings but never show (src/core/text.js marks them).
const printed = (w1, w2) => state.data.words.slice(w1, w2).filter(w => !w.filler).map(w => w.text).join(' ');

// ---------------------------------------------------------------- decisions (mirrors src/core/review.js)

const KEYS = {flag: 'flags', edit: 'edits', heading: 'headings', names: 'names', turn: 'turns'};
const reviewKey = it => KEYS[it.type];
// An "every time" word-list correction counts as accepted until someone skips it, like the person's own edits
// (mirrors decisionFor).
const decision = it => state.data.review[reviewKey(it)]?.[it.id] ??
  (it.source === 'staff' || (it.source === 'list' && it.always) ? 'accepted'
    : it.listPick?.auto ? {choice: 'list'} : undefined);
function resolved(it, d = decision(it)) {
  if (!d) return null;
  if (it.type === 'flag') {
    if (d.choice === 'whisper') return it.whisper;
    if (d.choice === 'claude') return it.pick ? it.pick.text : null;
    if (d.choice === 'list') return it.listPick ? it.listPick.text : null;
    if (d.choice === 'custom') return d.text ?? '';
    return null;
  }
  if (it.type === 'edit') return d === 'accepted' ? it.text : null;
  return null;
}
function done(it, d = decision(it)) {
  return it.type === 'flag' ? Boolean(d && d.choice) : d === 'accepted' || d === 'skipped';
}
const remaining = () => state.items.filter(it => !done(it)).length;

// What accepting an item would choose: the word list's reading first, then Claude's. Null when nobody has a
// suggestion, which leaves the item for a person.
function suggestion(it) {
  if (it.type === 'flag') {
    const t = it.listPick ? it.listPick.text : it.pick ? it.pick.text : null;
    if (t === null) return null;
    if (it.listPick) return t === it.parakeet ? {choice: 'parakeet'} : t === it.whisper ? {choice: 'whisper'} : {choice: 'list'};
    return {choice: it.pick.choice === 'other' ? 'claude' : it.pick.choice};
  }
  return 'accepted';
}

// Speakers (mirrors speakerName and turns in src/core/review.js).
const conversation = () => (state.data.speakers || []).length >= 2;
function speakerName(label) {
  const r = state.data.review;
  if (r.speakers?.[label]) return r.speakers[label];
  if (r.names?.n1 === 'accepted') { const v = state.data.aiSpeakers.find(s => s.label === label); if (v) return v.name; }
  return label;
}
function turnStarts() {
  const out = new Map();
  if (!conversation()) return out;
  const r = state.data.review;
  const fixes = new Map(state.data.speakerFixes.filter(t => r.turns?.[t.id] === 'accepted').map(t => [t.seg, t.to]));
  let last = null;
  for (const seg of state.data.segments) {
    const label = fixes.get(seg.id) || seg.speaker || last;
    if (label && label !== last) out.set(seg.w0, label);
    last = label;
  }
  return out;
}

function setDecision(it, value) {
  state.undoAll = null;
  const key = reviewKey(it);
  const r = state.data.review;
  r[key] = {...(r[key] || {})};
  if (value === null) delete r[key][it.id]; else r[key][it.id] = value;
  clearTimeout(state.saving);
  const id = state.id, snapshot = JSON.parse(JSON.stringify(r));
  state.saving = setTimeout(() => desk.saveReview(id, snapshot), 250);
  if (it.type === 'names' || it.type === 'turn') rebuildDoc(); else renderItem(it);
  renderTicks();
  renderMeta();
}

// ---------------------------------------------------------------- the list of transcripts

function jobStatus(job) {
  const s = job.steps || {};
  const err = STEP_ORDER.find(k => s[k]?.state === 'error' && k !== 'whisper');
  if (err) return {text: `${STEP_NAMES[err]} failed`, error: true};
  const running = STEP_ORDER.find(k => s[k]?.state === 'running');
  if (running) return {text: STEP_NAMES[running]};
  if (s.compare?.state !== 'done') return {text: 'Waiting to transcribe'};
  const p = job.progress, length = job.seconds ? ' · ' + clock(job.seconds) : '';
  if (p && p.total && p.done < p.total) return {text: `${p.total - p.done} to review${length}`};
  return {text: `Reviewed${length}`};
}

function jobRow(job) {
  const st = jobStatus(job);
  return h('button', {class: 'job-row', type: 'button', 'aria-current': job.id === state.id && state.view === 'job' ? 'true' : 'false',
    title: job.title, onclick: () => selectJob(job.id), oncontextmenu: e => { e.preventDefault(); selectJob(job.id).then(() => toggleMenu(true)); }},
    h('span', {class: 'job-title'}, job.title),
    h('span', {class: 'job-meta' + (st.error ? ' error' : '')}, st.text));
}

function renderSidebar() {
  const nav = $('#jobs');
  nav.replaceChildren();
  if (!state.jobs.length) { nav.append(h('p', {class: 'jobs-empty'}, 'Recordings you add appear here.')); return; }
  for (const job of state.jobs) nav.append(jobRow(job));
}

async function refreshJobs() {
  state.jobs = await desk.jobs();
  renderSidebar();
}

// ---------------------------------------------------------------- selecting and opening a transcript

async function selectJob(id) {
  stopAudio();
  state.id = id; state.view = 'job'; state.tab = 'transcript';
  state.notice = null; state.owning = false; state.exported = null; state.reloadOnPause = false; state.undoAll = null;
  state.data = await desk.open(id);
  if (!state.data) { state.id = null; return render(); }
  state.items = state.data.items;
  state.mode = 'all';
  state.idx = firstIn();
  state.groupsOpen = new Set(); state.changesKeep = new Set();
  render();
}

function home() {
  stopAudio();
  state.id = null; state.data = null; state.items = [];
  render();
}

function render() {
  renderSidebar();
  const main = $('#main');
  main.replaceChildren();
  if (!state.id || !state.data) return renderEmpty(main);
  renderJob(main);
}

// The way in: drop recordings anywhere in the window, or choose them. The names are optional; they tell the
// engines how many voices to listen for and how to spell them.
function renderEmpty(main) {
  const people = h('input', {type: 'text', class: 'link-input people', placeholder: 'Who’s speaking (optional): Ada Park, Sam Ortiz',
    'aria-label': 'Who is speaking', autocomplete: 'off'});
  people.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); chooseRecordings(people.value.trim()); } e.stopPropagation(); });
  const zone = h('div', {class: 'drop-zone big', id: 'drop-zone'},
    h('p', {class: 'zone-title'}, 'Drop audio or video files here'),
    h('p', {class: 'zone-hint'}, 'MP3, M4A, WAV, AIFF, FLAC, MP4, MOV and more. Everything stays on this Mac.'),
    h('button', {class: 'btn primary', type: 'button', onclick: () => chooseRecordings(people.value.trim())}, 'Choose files…', kbd('⌘O')));
  const notice = state.notice ? h('div', {class: 'notice', role: 'status'}, h('strong', {}, state.notice.title), h('span', {}, state.notice.text),
    h('button', {class: 'btn quiet', type: 'button', onclick: () => { state.notice = null; render(); }}, 'Dismiss')) : null;
  main.append(h('div', {class: 'drag-bar drag'}), h('div', {class: 'empty'}, h('div', {class: 'empty-inner'},
    notice, zone, people,
    h('p', {class: 'empty-help'}, 'Two engines transcribe each recording. Every place they disagree is flagged, so you listen only to those.'))));
}

// ---------------------------------------------------------------- the transcript screen

function ready() { return state.data.job.steps.compare?.state === 'done' && state.data.words.length; }

function renderJob(main) {
  const {job} = state.data;
  const head = h('header', {class: 'job-head drag'},
    h('div', {}, h('h1', {}, job.title), h('div', {class: 'meta', id: 'meta'})),
    h('div', {class: 'job-actions'},
      ready() ? h('div', {class: 'seg', role: 'group', 'aria-label': 'View'},
        h('button', {type: 'button', 'aria-pressed': String(state.tab === 'transcript'), onclick: () => setTab('transcript')}, 'Transcript'),
        h('button', {type: 'button', id: 'tab-changes', 'aria-pressed': String(state.tab === 'changes'), onclick: () => setTab('changes')}, changesLabel())) : null,
      h('div', {class: 'menu-wrap'},
        h('button', {class: 'icon-btn', type: 'button', 'aria-label': 'More', title: 'More', onclick: () => toggleMenu()},
          h('span', {class: 'more', 'aria-hidden': 'true'}, '···')),
        h('div', {class: 'menu', id: 'job-menu', hidden: true})),
      ready() ? h('button', {class: 'btn primary', type: 'button', id: 'export-btn', onclick: exportJob, title: 'Export (⌘E)'}, 'Export…') : null));
  main.append(head);
  if (state.notice) main.append(h('div', {class: 'notice', role: 'status'}, h('strong', {}, state.notice.title), h('span', {}, state.notice.text),
    h('button', {class: 'btn quiet', type: 'button', onclick: () => { state.notice = null; render(); }}, 'Dismiss')));
  if (!ready()) {
    main.append(h('div', {class: 'body single'}, h('div', {class: 'reading'}, renderSteps())));
  } else if (state.tab === 'changes') {
    main.append(h('div', {class: 'body single'}, renderChanges()));
  } else {
    const reading = h('div', {class: 'reading', id: 'reading'}, buildDoc());
    main.append(h('div', {class: 'body'}, reading, h('aside', {class: 'rail', id: 'rail'},
      h('div', {class: 'modebar', id: 'modebar'}), h('div', {id: 'card-slot', 'aria-live': 'polite'}))));
    renderCard();
  }
  if (ready()) main.append(renderPlayer());
  renderMeta();
}

function renderMeta() {
  const el = $('#meta');
  if (!el || !state.data) return;
  const {job} = state.data;
  const parts = [`Added ${dateLabel(job.createdAt)}`];
  if (job.seconds) parts.push(clock(job.seconds));
  if (conversation() && ready()) parts.push(`${state.data.speakers.length} speakers`);
  if (ready()) {
    const left = remaining();
    parts.push(state.items.length ? (left ? `${left} of ${state.items.length} to review` : 'Everything reviewed') : 'Nothing flagged');
  }
  el.replaceChildren(parts.join(' · '));
  const tab = $('#tab-changes');
  if (tab) tab.textContent = changesLabel();
  if (job.steps.whisper?.state === 'error') el.append(' · ', h('span', {class: 'working', title: job.steps.whisper.error || ''}, 'Whisper failed, so nothing is flagged'));
  if (state.exported) el.append(' · ', `Exported ${state.exported}`);
}

async function setTab(tab) {
  stopAudio();
  state.tab = tab;
  if (tab === 'changes') state.changesKeep = new Set();
  render();
  if (tab === 'transcript') scrollToCurrent(false);
}

function toggleMenu(force) {
  const menu = $('#job-menu');
  if (!menu) return;
  const open = force ?? menu.hidden;
  menu.hidden = !open;
  if (!open) return;
  const s = state.data.job.steps;
  const item = (label, fn, disabled) => h('button', {type: 'button', disabled, onclick: () => { menu.hidden = true; fn(); }}, label);
  menu.replaceChildren(
    item('Transcribe again', () => rerun('parakeet'), STEP_ORDER.some(k => s[k]?.state === 'running')),
    h('hr'),
    item('Show in Finder', () => desk.reveal(state.id)),
    item('Move to Trash', trashJob));
  setTimeout(() => document.addEventListener('click', function close(e) {
    if (!menu.contains(e.target)) { menu.hidden = true; document.removeEventListener('click', close); }
  }), 0);
}

async function rerun(step) {
  await desk.rerun(state.id, step);
  await selectJob(state.id);
}

async function trashJob() {
  const id = state.id;
  stopAudio();
  await desk.trash(id);
  state.id = null; state.data = null;
  await refreshJobs();
  render();
}

function renderSteps() {
  const s = state.data.job.steps;
  return h('div', {class: 'steps'}, h('h2', {}, 'Getting the transcript ready'),
    ...STEP_ORDER.filter(k => k !== 'download').map(k => {
      const st = s[k] || {state: 'pending'};
      let when = '';
      if (st.state === 'running' && st.startedAt) when = st.info || 'working';
      if (st.state === 'done' && st.startedAt && st.endedAt) when = `${Math.max(1, Math.round((new Date(st.endedAt) - new Date(st.startedAt)) / 1000))} s`;
      return h('div', {class: `step ${st.state}`}, h('span', {class: 'dot'}), h('span', {class: 'what'}, STEP_NAMES[k]),
        h('span', {class: 'when'}, when),
        st.state === 'error' ? h('div', {class: 'err'}, st.error || 'Failed.', ' ',
          h('button', {class: 'btn quiet', type: 'button', onclick: () => rerun(k)}, 'Try again')) : null);
    }));
}

// ---------------------------------------------------------------- the transcript

function itemsByStart() {
  const at = new Map();
  for (const it of state.items) at.set(it.w1, [...(at.get(it.w1) || []), it]);
  return at;
}

function wordSpan(i) {
  const w = state.data.words[i];
  const el = h('span', {class: 'w', 'data-i': i}, w.text);
  state.wordEl[i] = el;
  return el;
}

// One item's element. Its words stay clickable. A suggestion not yet decided shows as a tracked change, as in the
// card: the words heard struck out, then the suggestion. Once decided only the result shows, with a hairline
// underline; places nobody has a suggestion for keep the gold mark.
function itemEl(it) {
  const {words} = state.data;
  const d = decision(it), isDone = done(it, d);
  const shown = isDone ? d : suggestion(it), text = resolved(it, shown);
  const original = printed(it.w1, it.w2);
  const cls = ['item', it.type, isDone ? 'done' : shown != null ? 'proposed' : 'pending'];
  if (it.type === 'turn') {
    // Claude thinks the next words belong to another voice; once decided the label above says so.
    const el = h('span', {class: cls.concat('turn-mark').join(' '), 'data-id': it.id, title: 'Speaker check'}, '⇄');
    if (isDone) el.hidden = true;
    el.addEventListener('click', e => { e.stopPropagation(); if (e.detail > 1 || !getSelection().isCollapsed) return; goTo(state.items.indexOf(it), {fromClick: true, play: true}); });
    return el;
  }
  if (it.type === 'heading') {
    const el = h('h3', {class: `heading item ${d === 'accepted' ? 'done' : 'proposed'}`, 'data-id': it.id,
      title: d === 'accepted' ? '' : 'Suggested heading'}, it.text);
    if (d === 'skipped') el.hidden = true;
    el.addEventListener('click', () => goTo(state.items.indexOf(it), {fromClick: true}));
    return el;
  }
  let el;
  if (it.w1 === it.w2) {
    // Words only Whisper heard, between two of Parakeet's.
    el = text && !isDone ? h('span', {class: cls.concat('tracked').join(' '), 'data-id': it.id}, h('ins', {}, text))
      : text ? h('span', {class: cls.concat('changed').join(' '), 'data-id': it.id, title: 'Added'}, text)
      : h('span', {class: cls.concat(isDone ? 'kept' : 'insert').join(' '), 'data-id': it.id, title: `Whisper heard “${it.whisper}”`}, isDone ? '' : '+');
    if (isDone && !text) el.hidden = true;
  } else if (text !== null && text !== original) {
    // Removed words leave only a hairline, so the place can still be found and changed back.
    el = !isDone ? h('span', {class: cls.concat('tracked').join(' '), 'data-id': it.id},
        original ? h('del', {}, original) : null, text ? h('ins', {}, text) : null)
      : text ? h('span', {class: cls.concat('changed').join(' '), 'data-id': it.id, title: `Was: ${original}`}, text)
      : h('span', {class: cls.concat('changed', 'gone').join(' '), 'data-id': it.id, title: `Removed: ${original}`});
    for (let i = it.w1; i < it.w2; i++) state.wordEl[i] = el;
  } else {
    el = h('span', {class: cls.join(' '), 'data-id': it.id});
    let first = true;
    for (let i = it.w1; i < it.w2; i++) {
      if (words[i].filler) continue;
      if (!first) el.append(' ');
      el.append(wordSpan(i)); first = false;
    }
    // Only um and uh here: shown while the spot waits for a decision, then gone like any other filler.
    if (first) { if (isDone) el.hidden = true; else el.append(words.slice(it.w1, it.w2).map(w => w.text).join(' ')); }
  }
  // A click opens the spot and plays it; selecting or double-clicking words in it is for editing.
  el.addEventListener('click', e => { e.stopPropagation(); if (e.detail > 1 || !getSelection().isCollapsed) return; goTo(state.items.indexOf(it), {fromClick: true, play: true}); });
  return el;
}

function buildDoc() {
  const {words, paragraphs} = state.data;
  state.wordEl = new Array(words.length);
  const starts = new Set(paragraphs);
  const at = itemsByStart();
  const turnAt = turnStarts();
  const doc = h('article', {class: 'doc', id: 'doc', 'data-mode': state.mode});
  let p = null;
  const para = () => { p = h('p'); doc.append(p); };
  for (let i = 0; i < words.length; i++) {
    const here = (at.get(i) || []).filter(x => x.type !== 'names');
    if (!p || starts.has(i) || turnAt.has(i) || here.some(it => it.type === 'heading')) {
      for (const it of here.filter(x => x.type === 'heading')) doc.append(itemEl(it));
      if (turnAt.has(i)) doc.append(speakerEl(turnAt.get(i)));
      para();
    }
    for (const it of here.filter(x => x.type !== 'heading' && x.w1 === x.w2)) { p.append(itemEl(it), ' '); }
    const range = here.find(x => x.type !== 'heading' && x.w2 > x.w1);
    if (range) { p.append(itemEl(range), ' '); i = range.w2 - 1; continue; }
    if (words[i].filler) continue;
    p.append(wordSpan(i), ' ');
  }
  // Insertions after the last word.
  for (const it of (at.get(words.length) || []).filter(x => x.type !== 'heading')) { if (!p) para(); p.append(itemEl(it)); }
  doc.addEventListener('click', e => {
    if (e.detail > 1 || !getSelection().isCollapsed) return;
    // A word plays for a few seconds; Space carries on from there.
    const w = e.target.closest('.w');
    if (w && !e.target.closest('.item')) { const s = state.data.words[+w.dataset.i].s; seek(s - 0.25, true); state.stopAt = s + 3.5; state.clip = null; }
  });
  doc.addEventListener('mouseup', () => setTimeout(editSelection, 0));
  doc.addEventListener('contextmenu', docMenu);
  requestAnimationFrame(() => markCurrent());
  return doc;
}

// A speaker's name above their turn. Clicking it renames that voice everywhere.
function speakerEl(label) {
  let name = speakerName(label), proposed = false;
  if (name === label && !state.data.review.names?.n1) {
    const v = state.data.aiSpeakers.find(s => s.label === label);
    if (v) { name = v.name; proposed = true; }
  }
  const el = h('p', {class: 'speaker' + (name === label ? ' unnamed' : '') + (proposed ? ' proposed' : ''), 'data-label': label,
    title: proposed ? 'Claude’s suggestion. Click to rename.' : 'Click to rename'}, name);
  el.addEventListener('click', () => {
    const input = h('input', {type: 'text', class: 'speaker-input', value: name === label ? '' : name, placeholder: label, 'aria-label': `Name for ${label}`});
    const finish = keep => {
      if (keep) {
        const r = state.data.review;
        state.undoAll = null;
        r.speakers = {...(r.speakers || {})};
        if (input.value.trim()) r.speakers[label] = input.value.trim(); else delete r.speakers[label];
        desk.saveReview(state.id, r);
      }
      rebuildDoc();
      renderCard();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    el.replaceChildren(input);
    input.focus(); input.select();
  }, {once: true});
  return el;
}

function rebuildDoc() {
  const box = $('#reading'), old = $('#doc');
  if (!box || !old) return;
  const top = box.scrollTop;
  old.replaceWith(buildDoc());
  box.scrollTop = top;
}

function renderItem(it) {
  const old = document.querySelector(`[data-id="${it.id}"]`);
  if (!old) return;
  const el = itemEl(it);
  old.replaceWith(el);
  markCurrent();
}

function markCurrent() {
  document.querySelectorAll('.item.current').forEach(el => el.classList.remove('current'));
  const it = state.items[state.idx];
  if (!it) return;
  const el = document.querySelector(`[data-id="${it.id}"]`);
  if (el) el.classList.add('current');
}

function scrollToCurrent(smooth = true) {
  const it = state.items[state.idx];
  const el = it && document.querySelector(`[data-id="${it.id}"]`);
  const box = $('#reading');
  if (!el || !box) return;
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top < b.top + 80 || r.bottom > b.bottom - 80) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({block: 'center', behavior: smooth && !reduce ? 'smooth' : 'auto'});
  }
}

// ---------------------------------------------------------------- moving through the items

// One list in reading order. Spots that need ears (the engines heard different words, a speaker check) play
// as you reach them; Claude's edits wait to be read.
const HEAR = new Set(['flag', 'turn']);
const inMode = () => true;
const listen = it => Boolean(it && HEAR.has(it.type));

function goTo(idx, {fromClick = false, play = false} = {}) {
  if (!state.items.length) return;
  state.idx = Math.max(0, Math.min(state.items.length - 1, idx));
  const it = state.items[state.idx];
  state.owning = false;
  markCurrent();
  renderCard();
  renderTicks();
  if (!fromClick) scrollToCurrent();
  if (play) playItem(it);
}

// The next or previous item; a spot to hear starts playing. When the current one has scrolled out of sight,
// J and Next go on from where you are reading: the first item below the top of the transcript (K and Previous,
// the last one above its bottom).
function step(dir) {
  const target = fromView(dir);
  if (target >= 0) return goTo(target, {play: listen(state.items[target])});
  for (let j = state.idx + dir; j >= 0 && j < state.items.length; j += dir) {
    if (inMode(state.items[j])) return goTo(j, {play: listen(state.items[j])});
  }
}

function fromView(dir) {
  const box = $('#reading'), cur = state.items[state.idx];
  const at = it => { const el = it && document.querySelector(`.doc [data-id="${it.id}"]`); return el && el.getClientRects().length ? el.getBoundingClientRect() : null; };
  const r = at(cur);
  if (!box || !r) return -1;
  const b = box.getBoundingClientRect();
  if (r.bottom >= b.top && r.top <= b.bottom) return -1;
  if (dir > 0) return state.items.findIndex(it => { const q = at(it); return q && q.top >= b.top; });
  for (let j = state.items.length - 1; j >= 0; j--) { const q = at(state.items[j]); if (q && q.bottom <= b.bottom) return j; }
  return -1;
}

function nextUndone(from = state.idx) {
  const n = state.items.length;
  for (let k = 1; k <= n; k++) { const j = (from + k) % n, it = state.items[j]; if (inMode(it) && !done(it)) return j; }
  return -1;
}

// After a decision: the next item of the same kind that still needs one, already playing if it is a spot to hear.
function advance() {
  const j = nextUndone();
  if (j < 0) { renderCard(); renderModeBar(); return; }
  goTo(j, {play: listen(state.items[j])});
}

function firstIn() {
  const j = state.items.findIndex(it => !done(it));
  return j >= 0 ? j : 0;
}

// How much is left, at the top of the card.
function renderModeBar() {
  const bar = $('#modebar');
  if (!bar || !state.data) return;
  const left = remaining(), total = state.items.length;
  const open = state.items.filter(it => !done(it));
  const ready = open.filter(it => suggestion(it) !== null).length, yours = open.length - ready;
  const row = h('div', {class: 'progress-row'});
  if (state.undoAll) {
    row.append(h('span', {}, `Accepted ${state.undoAll.n}.`), h('button', {class: 'btn quiet', type: 'button', onclick: undoAcceptAll}, 'Undo'));
  } else if (ready) {
    row.append(h('button', {class: 'btn', type: 'button', onclick: () => setTab('changes'), title: 'Accept the stutters, punctuation and the rest a group at a time'},
      'Accept by group'));
    if (yours) row.append(h('span', {class: 'n'}, `${yours} with no suggestion`));
  }
  bar.replaceChildren(h('div', {class: 'progress'},
    h('span', {}, total ? (left ? `${left} of ${total} left to review` : 'Everything reviewed') : 'Nothing to review'),
    h('span', {class: 'bar'}, h('span', {style: `width:${total ? ((total - left) / total) * 100 : 100}%`}))),
    ...(row.childNodes.length ? [row] : []));   // replaceChildren would print a null as "null"
}

// Accept every suggestion not yet decided, or those in one group. What you decided, edited or skipped stays
// as it is.
async function acceptAll(group = null) {
  const r = state.data.review, before = JSON.parse(JSON.stringify(r));
  const take = list => {
    let m = 0;
    for (const it of list) {
      if (done(it) || (group && it.group !== group)) continue;
      const s = suggestion(it);
      if (s === null) continue;
      const key = reviewKey(it);
      r[key] = {...(r[key] || {}), [it.id]: s};
      if (it.type === 'names') {
        r.speakers = {...(r.speakers || {})};
        for (const v of it.names) if (!r.speakers[v.label]) r.speakers[v.label] = v.name;
      }
      m++;
    }
    return m;
  };
  const n = take(state.items);
  if (!n) return;
  clearTimeout(state.saving);
  await desk.saveReview(state.id, r);
  state.undoAll = {n, before, group};
  afterBulk();
}

async function undoAcceptAll() {
  if (!state.undoAll) return;
  state.data.review = state.undoAll.before;
  state.undoAll = null;
  await desk.saveReview(state.id, state.data.review);
  afterBulk();
}

function afterBulk() {
  rebuildDoc();
  const j = state.items.findIndex(it => !done(it));
  if (j >= 0) state.idx = j;
  markCurrent(); renderCard(); renderTicks(); renderMeta();
}

// ---------------------------------------------------------------- the rail card

function choiceRow(label, words, key, pressed, onclick, tag) {
  return h('button', {class: 'choice' + (tag ? ' suggested' : ''), type: 'button', 'aria-pressed': String(Boolean(pressed)), onclick,
    title: key ? `${label} (${key})` : label},
    h('span', {class: 'who'}, label),
    h('span', {class: 'words' + (words ? '' : ' none')}, words || 'no words'),
    tag ? h('span', {class: 'pick-tag'}, tag) : null);
}

// The words around an item, about a dozen either side, with the item marked: a pending edit as a tracked change,
// words only Whisper heard in brackets.
function context(it) {
  const {words} = state.data;
  // The words around it as they now read, with decided changes in place.
  const around = 14;
  const before = currentText(Math.max(0, it.w1 - 40), it.w1).split(' ').filter(Boolean).slice(-around);
  const after = currentText(it.w2, Math.min(words.length, it.w2 + 40)).split(' ').filter(Boolean).slice(0, around);
  const original = printed(it.w1, it.w2);
  const now = resolved(it);
  let mark;
  if (it.type === 'edit' && !done(it)) mark = h('mark', {}, original ? h('del', {}, original) : null, original ? ' ' : '', h('ins', {}, it.text || '(removed)'));
  else if (it.type === 'flag' && it.w1 === it.w2) mark = h('mark', {class: 'only-whisper'}, now || `⟨${it.whisper}⟩`);
  else mark = h('mark', {}, now !== null && now !== original ? now : original || '…');
  return h('p', {class: 'context'}, it.w1 - before.length > 0 ? '… ' : '', before.join(' '), ' ', mark, ' ', after.join(' '),
    it.w2 + after.length < words.length ? ' …' : '');
}

// A small timeline of the clip: the stretch in question shaded, the playhead moving through it.
function clipBar(it) {
  const from = Math.max(0, it.at - 1.6), to = (it.end ?? it.at) + 1.4, span = Math.max(0.5, to - from);
  const band = h('span', {class: 'band', style: `left:${((it.at - from) / span) * 100}%;width:${Math.max(1.5, (((it.end ?? it.at) - it.at) / span) * 100)}%`});
  const track = h('div', {class: 'clip-track', id: 'clip-track', title: 'Click to play from here'}, band, h('span', {class: 'clip-head', id: 'clip-head'}));
  track.addEventListener('click', e => {
    const r = track.getBoundingClientRect();
    seek(from + ((e.clientX - r.left) / r.width) * span, true);
    state.stopAt = to; state.clip = {from, to};
  });
  const playing = audio && !audio.paused && state.clip && state.clip.from === from;
  return h('div', {class: 'clip'},
    h('button', {class: 'play small', type: 'button', id: 'clip-play', 'aria-label': 'Play this spot (R)', title: 'Play this spot (R)',
      onclick: () => (playing ? audio.pause() : playItem(it))},
      playing ? svg('<path d="M2.5 1.5h3v11h-3zM8.5 1.5h3v11h-3z"/>') : svg('<path d="M3 1.5v11l9.5-5.5z"/>')),
    track,
    h('button', {class: 'btn quiet speed', type: 'button', id: 'clip-speed', title: 'Slower (S)', onclick: () => toggleSpeed()},
      audio && audio.playbackRate !== 1 ? '0.75×' : '1×'));
}

// What Claude found that a listener can check: the same words elsewhere in the recording (playable), a source,
// the word list, or the web.
const EVIDENCE = {recording: 'Recording', source: 'Source', word_list: 'Word list', web: 'Web', knowledge: 'Known'};
function evidenceEl(pick) {
  if (!pick?.evidence?.length) return null;
  return h('div', {class: 'evidence'},
    ...pick.evidence.map(e => h('div', {class: `ev ${e.kind}`},
      h('span', {class: 'ev-kind'}, EVIDENCE[e.kind] || e.kind),
      h('span', {class: 'ev-text'}, e.text),
      e.at !== null && e.at !== undefined
        ? h('button', {class: 'btn quiet ev-play', type: 'button', title: `Play ${clock(e.at)}`, onclick: () => playAt(e.at)}, `▶ ${clock(e.at)}`) : h('span'))));
}

// A moment elsewhere in the recording, a few seconds of it.
function playAt(t) {
  if (!audio) return;
  seek(Math.max(0, t - 0.8), true);
  state.stopAt = t + 4;
  state.clip = null;
  updateClip();
}

// ---- editing any words: select them in the transcript, then edit them right there

// A selection in the transcript offers an Edit button beside it; nothing else changes until it is used.
function editSelection() {
  const s = selectedWords();
  if (s) showEditChip(s.rect, s.lo, s.hi);
}

// The words a selection in the transcript covers: {lo, hi, rect}, or null.
function selectedWords() {
  const sel = getSelection(), doc = $('#doc');
  if (!sel || sel.isCollapsed || !doc || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!doc.contains(range.commonAncestorContainer)) return null;
  let lo = Infinity, hi = -Infinity;
  for (const el of doc.querySelectorAll('.w[data-i], .item[data-id]')) {
    if (!range.intersectsNode(el)) continue;
    if (el.dataset.i !== undefined) { lo = Math.min(lo, +el.dataset.i); hi = Math.max(hi, +el.dataset.i + 1); }
    else { const it = state.items.find(x => x.id === el.dataset.id); if (it && it.w2 > it.w1) { lo = Math.min(lo, it.w1); hi = Math.max(hi, it.w2); } }
  }
  return Number.isFinite(lo) && hi > lo ? {lo, hi, rect: range.getBoundingClientRect()} : null;
}

// Right-click a word, a change, or a selection to edit it.
async function docMenu(e) {
  let at = selectedWords();
  if (!at) {
    const itemEl = e.target.closest('.item[data-id]'), w = e.target.closest('.w[data-i]');
    const it = itemEl && state.items.find(x => x.id === itemEl.dataset.id);
    if (it && it.w2 > it.w1) at = {lo: it.w1, hi: it.w2, rect: itemEl.getBoundingClientRect()};
    else if (w) at = {lo: +w.dataset.i, hi: +w.dataset.i + 1, rect: w.getBoundingClientRect()};
  }
  if (!at) return;
  e.preventDefault();
  const choice = await desk.wordMenu([{id: 'edit', label: 'Edit…'}]);
  if (choice === 'edit') openEditor(at.lo, at.hi, null, at.rect);
}

// Where an anchor on screen sits inside the scrolling transcript.
function placeIn(box, rect, width) {
  const b = box.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left - b.left, box.clientWidth - width - 12));
  return {top: rect.bottom - b.top + box.scrollTop + 8, left};
}

function removeEditUi(which = 'all') {
  if (which !== 'pop') $('#edit-chip')?.remove();
  if (which !== 'chip') { $('#edit-pop')?.remove(); state.manual = null; }
  state.pendingEdit = null;
}

// Beside Edit, the paragraph at the first selected word: start one there, or join it to the one above.
function showEditChip(rect, lo, hi) {
  const box = $('#reading');
  if (!box || $('#edit-pop')) return;
  removeEditUi('chip');
  const at = placeIn(box, rect, 260);
  const joins = state.data.paragraphs.includes(lo);
  const edit = h('button', {class: 'edit-chip', type: 'button', onclick: () => openEditor(lo, hi, null, rect)}, 'Edit', kbd('E'));
  const para = lo > 0 ? h('button', {class: 'edit-chip quiet', type: 'button', onclick: () => toggleParagraph(lo)},
    joins ? 'Join paragraphs' : 'New paragraph', kbd('P')) : null;
  const chips = h('div', {class: 'edit-chips', id: 'edit-chip', style: `top:${at.top}px;left:${at.left}px`}, edit, para);
  chips.addEventListener('mousedown', e => e.preventDefault());   // keep the selection
  box.append(chips);
  state.pendingEdit = {lo, hi, rect};
}

// The person's paragraph changes sit in the review beside Claude's breaks: {add: [w], remove: [w]}.
async function toggleParagraph(w) {
  if (w <= 0) return;
  const r = state.data.review;
  const fix = {add: [], remove: [], ...(r.paragraphs || {})};
  const without = (list, x) => list.filter(y => y !== x);
  if (state.data.paragraphs.includes(w)) {
    if (fix.add.includes(w)) fix.add = without(fix.add, w); else fix.remove = [...without(fix.remove, w), w];
  } else if (fix.remove.includes(w)) fix.remove = without(fix.remove, w);
  else fix.add = [...without(fix.add, w), w];
  r.paragraphs = fix;
  state.undoAll = null;   // Accept all's Undo would take this back with it
  removeEditUi();
  getSelection().removeAllRanges();
  await desk.saveReview(state.id, r);
  await reopen();
}

// The words as they now read, with every decided change in place.
function currentText(w1, w2) {
  const {words} = state.data, out = [];
  for (let i = w1; i < w2; i++) {
    const it = state.items.find(x => x.w2 > x.w1 && x.w1 <= i && i < x.w2 && done(x) && resolved(x) !== null);
    if (it) { const t = resolved(it); if (t) out.push(t); i = it.w2 - 1; continue; }
    if (!words[i].filler) out.push(words[i].text);
  }
  return out.join(' ');
}

// A small editor under the words: the text, its clip, Save and Cancel. The rest of the screen holds still.
function openEditor(w1, w2, text, rect) {
  const box = $('#reading');
  if (!box) return;
  removeEditUi();
  stopClip();
  const {words} = state.data;
  if (!rect) {
    const el = document.querySelector(`[data-id="${state.items.find(x => x.w1 === w1 && x.w2 === w2)?.id}"]`) || state.wordEl[w1];
    rect = el ? el.getBoundingClientRect() : box.getBoundingClientRect();
  }
  state.manual = {w1, w2};
  const spot = {type: 'edit', w1, w2, at: words[w1].s, end: words[w2 - 1].e};
  const width = Math.min(460, box.clientWidth - 24);
  const at = placeIn(box, rect, width);
  const input = h('textarea', {class: 'manual-input', rows: '2', 'aria-label': 'The words as they should read'});
  input.value = text ?? currentText(w1, w2);
  const grow = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
  input.addEventListener('input', grow);
  const cancel = () => { stopClip(); removeEditUi(); getSelection().removeAllRanges(); };
  const save = () => { stopClip(); saveManual(input.value.trim()); };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  const playBtn = h('button', {class: 'btn quiet', type: 'button', title: 'Play these words', onclick: () => playItem(spot)}, '▶ Play');
  const pop = h('div', {class: 'edit-pop', id: 'edit-pop', role: 'dialog', 'aria-label': 'Edit the transcript',
    style: `top:${at.top}px;left:${at.left}px;width:${width}px`},
    h('div', {class: 'edit-pop-top'}, h('span', {class: 'label'}, `Edit · ${clock(spot.at)}`), playBtn),
    input,
    h('div', {class: 'actions'},
      h('button', {class: 'btn primary', type: 'button', onclick: save}, 'Save', kbd('⏎')),
      h('button', {class: 'btn quiet', type: 'button', onclick: cancel}, 'Cancel', kbd('esc'))));
  box.append(pop);
  requestAnimationFrame(() => {
    grow();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    // Keep the editor in view without moving the words above it.
    const r = pop.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.bottom > b.bottom - 12) box.scrollBy({top: r.bottom - b.bottom + 24, behavior: 'smooth'});
  });
}

// Older entry points: your edit's "Change it" and the E key.
function startManual(w1, w2, text) { openEditor(w1, w2, text, null); }

async function saveManual(text) {
  const m = state.manual, {words} = state.data, r = state.data.review;
  state.undoAll = null;   // Accept all's Undo would take this edit back with it
  // A new edit replaces any of yours on the same words.
  const replaced = (r.manual || []).filter(x => x.w1 < m.w2 && m.w1 < x.w2);
  r.manual = (r.manual || []).filter(x => !replaced.includes(x));
  if (text !== currentText(m.w1, m.w2) || text !== printed(m.w1, m.w2)) {
    const id = `m${Date.now().toString(36)}`;
    r.manual.push({id, w1: m.w1, w2: m.w2, text, at: words[m.w1].s, end: words[m.w2 - 1].e});
  }
  removeEditUi();
  getSelection().removeAllRanges();
  clearTimeout(state.saving);
  await desk.saveReview(state.id, r);
  await reopen();
}

async function removeManual(id) {
  const r = state.data.review;
  state.undoAll = null;
  r.manual = (r.manual || []).filter(x => x.id !== id);
  await desk.saveReview(state.id, r);
  await reopen();
}

function renderCard() {
  const slot = $('#card-slot');
  if (!slot) return;
  slot.replaceChildren();
  state.keys = {};
  renderModeBar();
  const it = state.items[state.idx];
  const mine = state.items.filter(inMode);
  if (!mine.length) {
    slot.append(h('div', {class: 'rail-done'}, h('p', {}, 'Nothing to review: the engines agree everywhere.')));
    return;
  }
  if (!it || !inMode(it)) return;
  const d = decision(it);
  const pos = mine.indexOf(it) + 1;
  const nav = (dir, label, key, path) => h('button', {class: 'icon-btn nav', type: 'button', 'aria-label': `${label} (${key})`,
    title: `${label} (${key})`, disabled: dir < 0 ? pos <= 1 : pos >= mine.length, onclick: () => step(dir)}, svg(path));
  const card = h('div', {class: 'card'}, h('div', {class: 'card-top'}, h('span', {class: 'label'}, cardLabel(it)),
    h('span', {class: 'pager'}, nav(-1, 'Previous', 'K', '<path d="M8.5 3 4.5 7l4 4"/>'),
      h('span', {class: 'count'}, `${pos} of ${mine.length}`), nav(1, 'Next', 'J', '<path d="M5.5 3l4 4-4 4"/>'))));
  if (it.type !== 'names' && it.type !== 'heading') card.append(clipBar(it));
  if (it.type !== 'names' && it.type !== 'heading') card.append(context(it));

  if (it.type === 'names') {
    // One question for all the voices: Claude's names, ready to correct before accepting.
    const r = state.data.review;
    const given = state.data.job.people || [];
    const inputs = state.data.speakers.map(v => {
      const sug = it.names.find(n => n.label === v.label);
      const input = h('input', {type: 'text', value: r.speakers?.[v.label] || sug?.name || '', placeholder: v.label, 'aria-label': `Name for ${v.label}`});
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); acceptNames(it, inputs); } e.stopPropagation(); });
      return {label: v.label, input, sug, share: v.share};
    });
    if (given.length) card.append(h('p', {class: 'reason'}, `You said: ${given.join(', ')}.`));
    card.append(h('div', {class: 'names'}, ...inputs.map(x => h('div', {class: 'name-row'},
      h('span', {class: 'who'}, `${x.label} · ${Math.round(x.share * 100)}%`), x.input,
      x.sug?.reason ? h('p', {class: 'why'}, x.sug.reason) : null))),
    h('div', {class: 'actions'},
      keyed(h('button', {class: 'btn' + (d === 'accepted' ? '' : ' primary'), type: 'button', onclick: () => acceptNames(it, inputs)}, d === 'accepted' ? 'Names used' : 'Use these names'), '⏎'),
      keyed(h('button', {class: 'btn quiet', type: 'button', onclick: () => decide(it, 'skipped')}, d === 'skipped' ? 'Skipped' : 'Skip'), 'X')),
    h('p', {class: 'reason'}, 'You can rename a voice later by clicking its name in the transcript.'));
  } else if (it.type === 'turn') {
    card.append(h('p', {class: 'edit-diff'}, h('del', {}, speakerName(it.from)), h('span', {class: 'arrow'}, '→'), h('ins', {}, speakerName(it.to))),
      h('p', {class: 'reason'}, it.reason),
      h('div', {class: 'actions'},
        keyed(h('button', {class: 'btn' + (d === 'accepted' ? '' : ' primary'), type: 'button', onclick: () => decide(it, 'accepted')}, d === 'accepted' ? 'Changed' : 'Change speaker'), '⏎'),
        keyed(h('button', {class: 'btn quiet', type: 'button', onclick: () => decide(it, 'skipped')}, d === 'skipped' ? 'Kept' : 'Keep'), 'X'),
        done(it) ? keyed(h('button', {class: 'btn quiet', type: 'button', onclick: () => decide(it, null)}, 'Undo'), 'U') : null));
  } else if (it.type === 'flag') {
    const pick = it.pick, lp = it.listPick;
    const choice = d?.choice;
    // Number keys follow the rows as shown. Each row says whose suggestion it is, so the words Enter will use
    // are always on screen.
    const tag = words => [lp && lp.text === words ? 'Word list' : null, pick && pick.text === words || (pick && pick.choice !== 'other' &&
      words === (pick.choice === 'parakeet' ? it.parakeet : it.whisper)) ? 'Claude’s pick' : null].filter(Boolean).join(' · ');
    const row = (label, words, value, t = tag(words)) => {
      const key = String(Object.keys(state.keys).length + 1);
      state.keys[key] = () => decide(it, value);
      return choiceRow(label, words, key, choice === value.choice, () => decide(it, value), t);
    };
    const choices = h('div', {class: 'choices'},
      row('Parakeet', it.parakeet, {choice: 'parakeet'}),
      row('Whisper', it.whisper, {choice: 'whisper'}));
    if (pick && pick.choice === 'other') choices.append(row('Claude', pick.text, {choice: 'claude'}, lp && lp.text === pick.text ? 'Word list' : ''));
    if (lp && lp.text !== it.parakeet && lp.text !== it.whisper && !(pick && pick.text === lp.text)) choices.append(row('Word list', lp.text, {choice: 'list'}, ''));
    if (choice === 'custom') choices.append(choiceRow('Typed', d.text, null, true, () => startOwn(it), ''));
    card.append(choices);
    // Why: the word list's rule, then Claude's reason and the evidence a listener can check.
    const why = h('div', {class: 'why-block'});
    if (lp) why.append(h('p', {class: 'why-line'}, h('span', {class: 'label'}, 'Word list'), ' ', lp.reason.replace(/^Word list:\s*/, '')));
    if (pick) why.append(h('p', {class: 'why-line'}, h('span', {class: 'label'}, `Claude${pick.confidence === 'high' ? '' : ` · ${pick.confidence} confidence`}`), ' ', pick.reason));
    const ev = evidenceEl(pick);
    if (ev) why.append(ev);
    if (why.childNodes.length) card.append(why);
    if (state.owning) {
      const input = h('input', {type: 'text', value: d?.text ?? (pick?.text || it.parakeet), 'aria-label': 'The words to use'});
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); state.owning = false; decide(it, {choice: 'custom', text: input.value.trim()}); }
        if (e.key === 'Escape') { e.preventDefault(); state.owning = false; renderCard(); }
        e.stopPropagation();
      });
      card.append(h('div', {class: 'own'}, input, h('div', {class: 'actions'},
        keyed(h('button', {class: 'btn primary', type: 'button', onclick: () => { state.owning = false; decide(it, {choice: 'custom', text: input.value.trim()}); }}, 'Use these words'), '⏎'),
        h('button', {class: 'btn quiet', type: 'button', onclick: () => { state.owning = false; renderCard(); }}, 'Cancel'))));
      requestAnimationFrame(() => { input.focus(); input.select(); });
    } else {
      const actions = h('div', {class: 'actions'});
      const sug = lp ? lp.text : pick ? pick.text : null;
      const short = t => (t.length > 26 ? t.slice(0, 25).trimEnd() + '…' : t) || 'no words';
      if (sug !== null && !done(it)) actions.append(keyed(h('button', {class: 'btn primary', type: 'button', onclick: () => acceptSuggestion(it)}, `Use “${short(sug)}”`), '⏎'));
      actions.append(keyed(h('button', {class: 'btn quiet', type: 'button', onclick: () => startOwn(it)}, 'Type it'), 'E'));
      if (done(it)) actions.append(keyed(h('button', {class: 'btn quiet', type: 'button', onclick: () => decide(it, null)}, 'Undo'), 'U'));
      card.append(actions);
    }
  } else if (it.type === 'edit' && it.source === 'staff') {
    card.append(h('div', {class: 'actions'},
      keyed(h('button', {class: 'btn', type: 'button', onclick: () => startManual(it.w1, it.w2, it.text)}, 'Change it'), 'E'),
      h('button', {class: 'btn quiet', type: 'button', onclick: () => removeManual(it.id)}, 'Remove my edit')));
  } else if (it.type === 'edit') {
    card.append(h('p', {class: 'reason'}, it.reason),
      h('div', {class: 'actions'},
        keyed(h('button', {class: 'btn' + (d === 'accepted' ? '' : ' primary'), type: 'button', 'aria-pressed': String(d === 'accepted'), onclick: () => decide(it, 'accepted')}, d === 'accepted' ? 'Accepted' : 'Accept'), '⏎'),
        keyed(h('button', {class: 'btn quiet', type: 'button', 'aria-pressed': String(d === 'skipped'), onclick: () => decide(it, 'skipped')}, d === 'skipped' ? 'Skipped' : 'Skip'), 'X'),
        done(it) && !(it.source === 'list' && it.always && d === 'accepted') ? keyed(h('button', {class: 'btn quiet', type: 'button', onclick: () => decide(it, null)}, 'Undo'), 'U') : null));
  } else {
    card.append(h('p', {class: 'edit-diff'}, h('ins', {}, it.text)),
      h('div', {class: 'actions'},
        keyed(h('button', {class: 'btn' + (d === 'accepted' ? '' : ' primary'), type: 'button', onclick: () => decide(it, 'accepted')}, d === 'accepted' ? 'Added' : 'Add heading'), '⏎'),
        keyed(h('button', {class: 'btn quiet', type: 'button', onclick: () => decide(it, 'skipped')}, d === 'skipped' ? 'Skipped' : 'Skip'), 'X'),
        done(it) ? keyed(h('button', {class: 'btn quiet', type: 'button', onclick: () => decide(it, null)}, 'Undo'), 'U') : null));
  }
  slot.append(card);
  const left = remaining();
  // Every key the card has, named once here: the number keys follow the readings as shown.
  const n = Object.keys(state.keys).length;
  const nums = n > 3 ? `1 to ${n} decide` : n === 3 ? '1, 2 or 3 decides' : '1 or 2 decides';
  const sug = it.type === 'flag' && !done(it) && (it.listPick || it.pick) ? ', Enter uses the suggestion' : '';
  slot.append(h('p', {class: 'rail-help'}, !left
    ? 'Everything is reviewed. Export saves the finished transcript.'
    : it.type === 'flag' ? `${nums}${sug}, E types it, U undoes. R replays, S slows it down, J and K move. Select any words in the transcript to change them.`
      : it.type === 'turn' ? 'Enter changes the speaker, X keeps it, U undoes. R replays, J and K move.'
        : 'Enter accepts, X skips, U undoes, J and K move. Click any word to hear it, or select words to change them.'));
}

function cardLabel(it) {
  const t = clock(it.at);
  if (it.type === 'flag') return it.w1 === it.w2 ? `Heard by one engine · ${t}` : `Engines disagree · ${t}`;
  if (it.type === 'edit') return it.source === 'list' ? `Word list correction · ${t}` : it.source === 'staff' ? `Your edit · ${t}`
    : `Claude suggests ${it.kind === 'word' ? 'a correction' : it.kind === 'quotation' ? 'quotation marks' : it.kind} · ${t}`;
  if (it.type === 'names') return 'Who is speaking';
  if (it.type === 'turn') return `Speaker check · ${t}`;
  return `Claude suggests a heading · ${t}`;
}

function decide(it, value) {
  const wasDone = done(it);
  // Undoing an "every time" correction from the word list means skipping it; left alone it would apply again.
  if (value === null && it.source === 'list' && it.always) value = 'skipped';
  setDecision(it, value);
  renderModeBar();
  if (value !== null && !wasDone) advance();
  else renderCard();
}

function acceptSuggestion(it) {
  if (it.type === 'flag') {
    // Your word list wins over Claude's reading.
    if (it.listPick) {
      const t = it.listPick.text;
      return decide(it, t === it.parakeet ? {choice: 'parakeet'} : t === it.whisper ? {choice: 'whisper'} : {choice: 'list'});
    }
    if (!it.pick) return;
    decide(it, {choice: it.pick.choice === 'other' ? 'claude' : it.pick.choice});
  } else if (it.type === 'names') {
    acceptNames(it, [...document.querySelectorAll('.name-row input')].map((input, k) => ({label: state.data.speakers[k].label, input})));
  } else decide(it, 'accepted');
}

// The names as typed in the card, which start as Claude's.
function acceptNames(it, inputs) {
  const r = state.data.review;
  r.speakers = {...(r.speakers || {})};
  for (const {label, input} of inputs) { const v = input.value.trim(); if (v) r.speakers[label] = v; else delete r.speakers[label]; }
  decide(it, 'accepted');
}

function startOwn(it) {
  if (it.type !== 'flag') return;
  state.owning = true;
  renderCard();
}

// ---------------------------------------------------------------- audio

let audio = null;

function renderPlayer() {
  audio = new Audio();
  audio.preload = 'auto';
  audio.src = `media/${state.id}`;
  const playBtn = h('button', {class: 'play', type: 'button', 'aria-label': 'Play', onclick: () => togglePlay()});
  const time = h('span', {class: 'time', id: 'time'}, '0:00');
  const track = h('div', {class: 'track', id: 'track', role: 'slider', 'aria-label': 'Position', tabindex: '-1'},
    h('div', {class: 'fill', id: 'fill'}), h('div', {class: 'ticks', id: 'ticks'}), h('div', {class: 'head', id: 'head'}));
  track.addEventListener('click', e => {
    const tick = e.target.closest('.tick');
    if (tick) { goTo(+tick.dataset.k, {play: true}); return; }
    const r = track.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * duration(), true);
  });
  const speed = h('button', {class: 'btn quiet speed', type: 'button', title: 'Playback speed (S)', onclick: () => toggleSpeed()}, '1×');
  speed.id = 'speed';
  const bar = h('div', {class: 'player'}, playBtn, time, track, speed);
  const icon = () => playBtn.replaceChildren(audio.paused
    ? svg('<path d="M3 1.5v11l9.5-5.5z"/>') : svg('<path d="M2.5 1.5h3v11h-3zM8.5 1.5h3v11h-3z"/>'));
  icon();
  audio.addEventListener('play', () => { icon(); follow(); });
  audio.addEventListener('pause', () => { icon(); updateClip(); if (state.reloadOnPause) reopen(); });
  audio.addEventListener('loadedmetadata', () => { renderTicks(); updateTime(); });
  audio.addEventListener('timeupdate', updateTime);
  return bar;
}

function svg(inner) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 14 14');
  el.innerHTML = inner;
  return el;
}

const duration = () => (audio && Number.isFinite(audio.duration) ? audio.duration : state.data?.job.seconds || 0);

function renderTicks() {
  const box = $('#ticks');
  if (!box) return;
  const dur = duration();
  box.replaceChildren(...(dur ? state.items.map((it, k) => {
    if (it.type === 'heading' || it.type === 'names' || !inMode(it)) return null;
    const cls = ['tick', done(it) ? 'done' : '', k === state.idx ? 'current' : ''].filter(Boolean).join(' ');
    return h('span', {class: cls, 'data-k': k, style: `left:${(it.at / dur) * 100}%`});
  }).filter(Boolean) : []));
}

function updateTime() {
  if (!audio) return;
  const t = audio.currentTime, dur = duration();
  const el = $('#time');
  if (el) el.textContent = `${clock(t)} / ${clock(dur)}`;
  const pct = dur ? (t / dur) * 100 : 0;
  const fill = $('#fill'), head = $('#head');
  if (fill) fill.style.width = `${pct}%`;
  if (head) head.style.left = `${pct}%`;
  if (state.stopAt !== null && t >= state.stopAt) { audio.pause(); state.stopAt = null; }
}

// The word being spoken, followed while the audio plays.
let followFrame = 0, lastNow = null;
function follow() {
  cancelAnimationFrame(followFrame);
  const words = state.data?.words;
  if (!audio || !words?.length) return;
  const tick = () => {
    const t = audio.currentTime;
    let lo = 0, hi = words.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (words[mid].s <= t) lo = mid; else hi = mid - 1; }
    const el = words[lo].s <= t + 0.05 ? state.wordEl[lo] : null;
    if (el !== lastNow) { lastNow?.classList.remove('now'); el?.classList.add('now'); lastNow = el; }
    updateTime();
    updateClip();
    if (!audio.paused) followFrame = requestAnimationFrame(tick);
  };
  tick();
}

function seek(t, play) {
  if (!audio) return;
  state.stopAt = null;
  audio.currentTime = Math.max(0, Math.min(t, duration() || t));
  if (play) audio.play().catch(() => {});
  else follow();
}

// A spot plays from a moment before it to a moment after, like a clip on the listening sheet.
function playItem(it) {
  if (!audio || !it || it.type === 'heading' || it.type === 'names') return;
  const from = Math.max(0, it.at - 1.6), to = (it.end ?? it.at) + 1.4;
  seek(from, true);
  state.stopAt = to;
  state.clip = {from, to};
}

function stopClip() {
  state.clip = null; state.stopAt = null;
  if (audio && !audio.paused) audio.pause();
}

// The card's play button and playhead follow the audio.
function updateClip() {
  const head = $('#clip-head'), btn = $('#clip-play');
  if (!audio || !state.clip) { if (head) head.style.opacity = '0'; return; }
  const {from, to} = state.clip, t = audio.currentTime;
  if (head) { head.style.opacity = t >= from && t <= to ? '1' : '0'; head.style.left = `${Math.max(0, Math.min(1, (t - from) / (to - from))) * 100}%`; }
  if (btn) btn.replaceChildren(audio.paused ? svg('<path d="M3 1.5v11l9.5-5.5z"/>') : svg('<path d="M2.5 1.5h3v11h-3zM8.5 1.5h3v11h-3z"/>'));
}

function togglePlay() {
  if (!audio) return;
  state.stopAt = null;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

function toggleSpeed() {
  if (!audio) return;
  audio.playbackRate = audio.playbackRate === 1 ? 0.75 : 1;
  for (const b of [$('#speed'), $('#clip-speed')]) if (b) b.textContent = audio.playbackRate === 1 ? '1×' : '0.75×';
}

function stopAudio() {
  cancelAnimationFrame(followFrame);
  lastNow = null;
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio = null; }
  state.stopAt = null;
}

// ---------------------------------------------------------------- the changes list

// Every item in one list, in the order it was said: what would change, why, and whether it is decided. Accept or
// skip here, or click one to hear it in place in the transcript. A row decided here stays in the list, marked,
// until the list is opened again, so nothing jumps.
const changesLabel = () => { const n = state.data && ready() ? remaining() : 0; return 'Changes' + (n ? ` · ${n}` : ''); };

const KIND_LABEL = {punctuation: 'Punctuation', style: 'Style', word: 'Correction', quotation: 'Quotation marks'};
function kindLabel(it) {
  if (it.type === 'flag') return it.w1 === it.w2 ? 'One engine only' : 'Engines differ';
  if (it.type === 'edit') return it.source === 'list' ? 'Word list' : it.source === 'staff' ? 'Your edit'
    : KIND_LABEL[it.kind] || 'Edit';
  return {heading: 'Heading', turn: 'Speaker check', names: 'Speakers'}[it.type];
}

function statusLabel(it, d) {
  if (it.type === 'flag') return {parakeet: 'Parakeet’s words', whisper: 'Whisper’s words', claude: 'Claude’s reading', list: 'Word list', custom: 'Your words'}[d.choice];
  if (it.type === 'edit' && it.source === 'staff') return 'Your edit';
  if (it.type === 'edit' && it.source === 'list' && it.always && d === 'accepted') return 'Fixed automatically';
  if (d === 'skipped') return it.type === 'turn' ? 'Kept' : 'Skipped';
  return {edit: 'Accepted', heading: 'Added', turn: 'Changed', names: 'Names used'}[it.type];
}

// The change with a few words either side, as the transcript now reads. Undecided, it shows the suggestion;
// decided, what was chosen.
function changeDiff(it) {
  const {words} = state.data;
  if (it.type === 'names') return h('p', {class: 'diff'}, it.names.map(n => `${n.label} → ${n.name}`).join(' · '));
  if (it.type === 'heading') return h('p', {class: 'diff'}, h('ins', {}, it.text));
  if (it.type === 'turn') return h('p', {class: 'diff'}, h('del', {}, speakerName(it.from)), ' → ', h('ins', {}, speakerName(it.to)));
  const d = decision(it), isDone = done(it, d);
  const text = resolved(it, isDone ? d : suggestion(it)), original = printed(it.w1, it.w2);
  const before = currentText(Math.max(0, it.w1 - 20), it.w1).split(' ').filter(Boolean).slice(-5);
  const after = currentText(it.w2, Math.min(words.length, it.w2 + 20)).split(' ').filter(Boolean).slice(0, 5);
  const mark = text !== null && text !== original ? [original ? h('del', {}, original) : null, text ? h('ins', {}, text) : null]
    : [h('span', {class: 'same'}, original || '…')];
  return h('p', {class: 'diff'}, h('span', {class: 'ctx'}, (it.w1 - before.length > 0 ? '… ' : '') + before.join(' ')), ' ', ...mark, ' ',
    h('span', {class: 'ctx'}, after.join(' ') + (it.w2 + after.length < words.length ? ' …' : '')));
}

function changeWhy(it) {
  if (it.type !== 'flag') return it.reason || null;
  const heard = it.w1 === it.w2 ? `Only Whisper heard “${it.whisper}”`
    : `Parakeet “${it.parakeet}” · ${it.whisper ? `Whisper “${it.whisper}”` : 'Whisper heard nothing'}`;
  const why = it.listPick ? it.listPick.reason.replace(/^Word list:\s*/, '') : it.pick?.reason;
  return why ? `${heard}. ${why}` : `${heard}. No suggestion.`;
}

function changeRow(it) {
  const d = decision(it), isDone = done(it, d), sug = suggestion(it);
  const stored = state.data.review[reviewKey(it)]?.[it.id] !== undefined;
  const stop = fn => e => { e.stopPropagation(); fn(); };
  const acts = h('div', {class: 'acts'});
  if (isDone) {
    acts.append(h('span', {class: 'status'}, statusLabel(it, d)));
    if (it.source === 'list' && it.always && d === 'accepted') acts.append(h('button', {class: 'btn quiet', type: 'button', onclick: stop(() => decideInList(it, 'skipped'))}, 'Skip'));
    else if (stored) acts.append(h('button', {class: 'btn quiet', type: 'button', onclick: stop(() => decideInList(it, null))}, 'Undo'));
  } else if (sug !== null) {
    acts.append(h('button', {class: 'btn', type: 'button', onclick: stop(() => decideInList(it, sug))}, 'Accept'));
    if (it.type !== 'flag') acts.append(h('button', {class: 'btn quiet', type: 'button', onclick: stop(() => decideInList(it, 'skipped'))}, it.type === 'turn' ? 'Keep' : 'Skip'));
  } else {
    acts.append(h('span', {class: 'status'}, 'Listen to decide'));
  }
  const why = changeWhy(it);
  const at = it.type === 'names' ? h('span', {class: 'at'})
    : it.type === 'heading' ? h('span', {class: 'at'}, clock(it.at))
    : h('button', {class: 'btn quiet at', type: 'button', title: 'Play this spot', onclick: stop(() => playItem(it))}, `▶ ${clock(it.at)}`);
  return h('li', {class: 'change' + (isDone ? ' done' : ''), 'data-change': it.id, title: 'Open in the transcript',
    onclick: () => { if (getSelection().isCollapsed) openInTranscript(it); }},
    at, h('div', {class: 'what'}, h('span', {class: 'label'}, kindLabel(it)), changeDiff(it), why ? h('p', {class: 'change-why'}, why) : null), acts);
}

function decideInList(it, value) {
  if (value === null && it.source === 'list' && it.always) value = 'skipped';
  if (it.type === 'names' && value === 'accepted') {
    const r = state.data.review;
    r.speakers = {...(r.speakers || {})};
    for (const v of it.names) if (!r.speakers[v.label]) r.speakers[v.label] = v.name;
  }
  state.changesKeep.add(it.id);
  setDecision(it, value);
  redrawChanges();
}

async function openInTranscript(it) {
  const j = state.items.indexOf(it);
  if (j < 0) return;
  state.idx = j;
  await setTab('transcript');
  goTo(j, {play: listen(it)});
}

function fillChangesBar(bar) {
  if (!bar) return;
  const open = state.items.filter(it => !done(it));
  const show = all => { state.changesAll = all; state.changesKeep = new Set(); redrawChanges(); };
  const filter = h('div', {class: 'seg', role: 'group', 'aria-label': 'Show'},
    h('button', {type: 'button', 'aria-pressed': String(!state.changesAll), onclick: () => show(false)}, 'To review', h('span', {class: 'n'}, String(open.length))),
    h('button', {type: 'button', 'aria-pressed': String(Boolean(state.changesAll)), onclick: () => show(true)}, 'All', h('span', {class: 'n'}, String(state.items.length))));
  bar.replaceChildren(filter);
}

// The groups, in the order the tab shows them (src/core/review.js decides which group an item is in).
const GROUP_INFO = {
  stutters: ['Stutters and false starts', 'Repeated words, abandoned starts and filler phrases, taken out.'],
  punctuation: ['Punctuation and capitals', 'Commas, periods, hyphens and capital letters. The words stay the same.'],
  style: ['Style', 'Dates, numbers, abbreviations and web addresses, written one consistent way.'],
  quotations: ['Quotation marks', 'Quotation marks around what the speaker reads aloud.'],
  corrections: ['Words Claude corrected', 'Claude thinks the engines misheard these words. Each one changes what the transcript says.'],
  hearing: ['Words to hear', 'The two engines heard different words.'],
  structure: ['Headings and speakers', 'Part headings, speaker names and changes of voice.'],
  list: ['Word list', 'Your spellings of names and terms.'],
  yours: ['Your edits', 'Changes you made yourself.'],
};

function groupHint(key, left) {
  const base = GROUP_INFO[key][1];
  if (key !== 'hearing') return base;
  // Claude's readings, once an AI pass has run; without one, every place is for a person to hear.
  if (!left.some(it => it.pick)) return `${base} Listen to each and choose.`;
  const unsure = left.filter(it => !suggestion(it) || it.pick?.confidence === 'low').length;
  return `${base} Claude picked a reading for each${unsure ? `, and is unsure of ${unsure}; listen to those` : ''}.`;
}

function groupEl(key, list) {
  const [title] = GROUP_INFO[key];
  const open = state.groupsOpen.has(key);
  const left = list.filter(it => !done(it));
  const count = !left.length ? `${list.length} decided` : left.length === list.length ? `${left.length} to review` : `${left.length} of ${list.length} to review`;
  const acts = h('div', {class: 'acts'});
  const ready = left.filter(it => suggestion(it) !== null);
  if (state.undoAll?.group === key) {
    acts.append(h('span', {class: 'status'}, `Accepted ${state.undoAll.n}`),
      h('button', {class: 'btn quiet', type: 'button', onclick: async () => { await undoAcceptAll(); redrawChanges(); }}, 'Undo'));
  } else if (ready.length) {
    acts.append(h('button', {class: 'btn', type: 'button', onclick: () => acceptGroup(key)}, ready.length === 1 ? 'Accept it' : `Accept all ${ready.length}`));
  } else if (left.length) {
    acts.append(h('span', {class: 'status'}, 'Listen to decide'));
  }
  const toggle = h('button', {class: 'group-toggle', type: 'button', 'aria-expanded': String(open), onclick: () => toggleGroup(key)},
    svg('<path d="M5 3.5 8.5 7 5 10.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
    h('span', {class: 'group-title'}, title), h('span', {class: 'n'}, count));
  return h('section', {class: 'group' + (open ? ' open' : ''), 'data-group': key},
    h('div', {class: 'group-head'}, toggle, acts),
    h('p', {class: 'group-hint'}, groupHint(key, left)),
    open ? h('ol', {class: 'change-list'}, ...list.map(changeRow)) : null);
}

function toggleGroup(key) {
  if (state.groupsOpen.has(key)) state.groupsOpen.delete(key); else state.groupsOpen.add(key);
  redrawChanges();
}

async function acceptGroup(key) {
  // The rows stay in the list, marked, so Undo has something to show.
  for (const it of state.items) if (it.group === key && !done(it)) state.changesKeep.add(it.id);
  await acceptAll(key);
  redrawChanges();
}

function renderChanges() {
  state.changesKeep ||= new Set();
  state.groupsOpen ||= new Set();
  const all = state.items;
  const shown = state.changesAll ? all : all.filter(it => !done(it) || state.changesKeep.has(it.id));
  const bar = h('div', {class: 'changes-bar', id: 'changes-bar'});
  fillChangesBar(bar);
  const wrap = h('div', {class: 'changes-inner'}, h('h2', {}, 'Changes'),
    h('p', {class: 'lede'}, 'Everything to review, in groups. Accept a group at once, or open it to go through it here in the order it was said. Click a change to hear it in the transcript.'), bar);
  if (!all.length) wrap.append(h('p', {class: 'q-summary'}, 'Nothing to review: the engines agree everywhere.'));
  else if (!shown.length) wrap.append(h('p', {class: 'q-summary'}, 'Everything is reviewed. All shows what was decided.'));
  else {
    const groups = Object.keys(GROUP_INFO).map(key => [key, shown.filter(it => it.group === key)]).filter(([, list]) => list.length);
    wrap.append(h('div', {class: 'groups'}, ...groups.map(([key, list]) => groupEl(key, list))));
  }
  return h('div', {class: 'changes', id: 'changes'}, wrap);
}

function redrawChanges() {
  const old = $('#changes');
  if (!old) return;
  const top = old.scrollTop, el = renderChanges();
  old.replaceWith(el);
  el.scrollTop = top;
}

// ---------------------------------------------------------------- the speech engines on a new Mac

// The line under the list: the models downloading, or a button to download them. Hidden once they are here.
function drawSpeech() {
  const s = state.speech || {state: 'unknown'};
  const pct = Math.round((s.progress || 0) * 100);
  const meter = () => h('span', {class: 'meter'}, h('span', {style: `width:${pct}%`}));
  const download = label => h('button', {class: 'btn quiet', type: 'button', onclick: async () => { state.speech = await desk.speechPrepare(); drawSpeech(); }}, label);
  const line = $('#setup-line');
  if (!line) return;
  const content = s.state === 'downloading' ? [h('span', {}, `Getting the speech engines ready · ${pct}%`), meter()]
    : s.state === 'missing' ? [h('span', {}, 'The speech engines need a one-time download, about 1.1 GB.'), download('Download')]
    : s.state === 'error' ? [h('span', {}, s.error || 'The download did not finish.'), download('Try again')]
    : s.state === 'unavailable' ? [h('span', {}, 'The speech engines are missing. Build them with npm run speech.')]
    : null;
  line.hidden = !content;
  line.classList.toggle('bad', s.state === 'error' || s.state === 'unavailable');
  if (content) line.replaceChildren(...content);
}

desk.onSpeech(s => { state.speech = s; drawSpeech(); });

// ---------------------------------------------------------------- adding recordings, exporting

async function addRecordings(paths, speakers = '') {
  if (!paths.length) return;
  const r = await desk.add(paths, speakers);
  await refreshJobs();
  if (r.added.length) await selectJob(r.added[0]);
  if (r.errors.length) { state.notice = {title: 'Not added.', text: r.errors.join(' ')}; render(); }
}

async function chooseRecordings(speakers = '') { addRecordings(await desk.choose(), speakers); }

async function exportJob() {
  if (!state.id || !ready()) return;
  const file = await desk.exportJob(state.id);
  if (file) { state.exported = file.split('/').pop(); renderMeta(); }
}

// ---------------------------------------------------------------- keyboard, drag and drop

// A press anywhere but the Edit button or the editor puts the button away.
document.addEventListener('mousedown', e => { if (!e.target.closest('#edit-chip, #edit-pop')) removeEditUi('chip'); });

// A mouse click leaves no focus ring behind, so Space and Enter go back to the player and the review.
document.addEventListener('click', e => { if (e.detail > 0) e.target.closest('button')?.blur(); });

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select')) return;
  if (e.target.closest('button') && (e.key === 'Enter' || e.key === ' ')) return;
  if (state.view !== 'job' || !state.data || !ready()) return;
  const onTranscript = state.tab === 'transcript';
  const it = state.items[state.idx];
  const k = e.key.toLowerCase();
  const act = fn => { e.preventDefault(); fn(); };
  if (k === 'e' && state.pendingEdit) { const pe = state.pendingEdit; return act(() => openEditor(pe.lo, pe.hi, null, pe.rect)); }
  if (k === 'p' && state.pendingEdit?.lo > 0) { const pe = state.pendingEdit; return act(() => toggleParagraph(pe.lo)); }
  if (e.key === ' ') return act(togglePlay);
  if (k === 's') return act(toggleSpeed);
  if (!onTranscript || !it) return;
  if (k === 'j' || e.key === 'ArrowDown') return act(() => step(1));
  if (k === 'k' || e.key === 'ArrowUp') return act(() => step(-1));
  if (k === 'r') return act(() => playItem(it));
  if (e.key === 'Enter') return act(() => acceptSuggestion(it));
  if (k === 'u') return act(() => decide(it, null));
  if (it.type === 'flag') {
    if (state.keys?.[k]) return act(state.keys[k]);
    if (k === 'e') return act(() => startOwn(it));
  } else if (it.source === 'staff') {
    // Your own edit is changed or removed from its card, never skipped by a stray key.
    if (k === 'e') return act(() => startManual(it.w1, it.w2, it.text));
  } else if (k === 'x' || e.key === 'Backspace') return act(() => decide(it, 'skipped'));
});

let dragDepth = 0;
const filesOf = e => [...(e.dataTransfer?.files || [])].map(f => desk.pathFor(f)).filter(Boolean);
window.addEventListener('dragenter', e => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  $('#drop-label').textContent = 'Drop to add recordings';
  $('#drop-veil').hidden = false;
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-veil').hidden = true; } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0; $('#drop-veil').hidden = true;
  const paths = filesOf(e), recordings = paths.filter(p => AUDIO_EXT.test(p));
  if (paths.length && !recordings.length) { state.notice = {title: 'Not added.', text: 'Those aren’t audio or video files.'}; render(); return; }
  addRecordings(recordings);
});

desk.onJob(async job => {
  const k = state.jobs.findIndex(j => j.id === job.id);
  if (k >= 0) state.jobs[k] = job; else state.jobs.unshift(job);
  renderSidebar();
  if (job.id !== state.id || state.view !== 'job') return;
  const before = state.data?.job.steps || {};
  state.data.job = {...state.data.job, ...job};
  // Reopen when a step finishes that changes what the screen shows.
  const changed = ['compare'].some(s => before[s]?.state !== job.steps[s]?.state);
  if (changed) {
    // Never cut off what someone is listening to; pick up the new results when the audio stops.
    if (audio && !audio.paused) { state.reloadOnPause = true; renderMeta(); return; }
    await reopen();
  } else if (!ready()) {
    render();
  } else renderMeta();
});

// Fresh data for the open job. When the transcript is on screen and its words are the same, only the text,
// the card and the timeline are redrawn: the scroll, the audio and the place in the list stay put.
async function reopen() {
  state.reloadOnPause = false;
  const keep = state.items[state.idx]?.id;
  const box = $('#reading'), top = box ? box.scrollTop : 0;
  const inPlace = Boolean(state.data && state.view === 'job' && state.tab === 'transcript' && $('#doc') && ready());
  const before = state.data?.words.length;
  state.data = await desk.open(state.id);
  state.items = state.data.items;
  const j = state.items.findIndex(it => it.id === keep);
  state.idx = j >= 0 ? j : Math.max(0, state.items.findIndex(it => !done(it)));
  if (inPlace && ready() && state.data.words.length === before) {
    rebuildDoc();
    const b = $('#reading');
    if (b) b.scrollTop = top;
    markCurrent(); renderCard(); renderTicks(); renderMeta(); renderSidebar();
    return;
  }
  stopAudio();
  render();
}

desk.onMenu(what => {
  if (what === 'add') chooseRecordings();
  if (what === 'export') exportJob();
});

$('#add-recording').addEventListener('click', () => chooseRecordings());

// Hooks for the screenshot run (npm run snapshot).
window.__test = {
  next: () => step(1),
  current: () => state.id || null,
  open: id => selectJob(id),
  home: () => home(),
  goto: id => { const j = state.items.findIndex(it => it.id === id); if (j >= 0) goTo(j); },
  edit: (w1, w2) => { state.wordEl[w1]?.scrollIntoView({block: 'center'}); return new Promise(r => setTimeout(() => { startManual(w1, w2); r($('#reading').scrollTop); }, 300)); },
  scrollTop: () => $('#reading')?.scrollTop,
  saveEdit: text => saveManual(text),
  acceptAll: () => acceptAll(),
  // Every item still open decided as heard, as a reviewer finishing up would.
  finish: async () => {
    const r = state.data.review;
    for (const it of state.items.filter(x => !done(x))) {
      const k = reviewKey(it);
      r[k] = {...(r[k] || {})};
      r[k][it.id] = it.type === 'flag' ? {choice: 'parakeet'} : 'skipped';
    }
    await desk.saveReview(state.id, r);
    await reopen();
  },
  group: key => toggleGroup(key),
  acceptGroup: key => acceptGroup(key),
  undoAll: () => undoAcceptAll(),
  accept: () => { const it = state.items[state.idx]; if (it) acceptSuggestion(it); },
  // A number key on the open card, as a reviewer choosing a reading would press it.
  key: n => state.keys?.[String(n)]?.(),
  tab: t => setTab(t),
  // The setup line as a new Mac shows it.
  setup: ({speech} = {}) => { if (speech) state.speech = speech; drawSpeech(); },
};

(async () => {
  await refreshJobs();
  if (state.jobs.length) await selectJob(state.jobs[0].id);
  else render();
  state.speech = await desk.speech();
  drawSpeech();
})();

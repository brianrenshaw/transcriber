// Runs each transcript's steps in order, one at a time: Parakeet, Whisper, the comparison.
// A step that finished is never run again unless the person asks; a failed step can be retried on its own.

const fs = require('node:fs');
const {readAsr} = require('../core/text');
const {compareEngines} = require('../core/compare');
const {emptyReview} = require('../core/review');
const wordlist = require('../core/wordlist');
const {STEPS} = require('./store');

// words: the person's word list, as wordlist.js reads it.
function create({store, speech, words = () => [], emit = () => {}}) {
  const queue = [];
  let busy = false;

  const update = (job, step, patch) => {
    job.steps[step] = {...job.steps[step], ...patch};
    store.save(job);
    emit(job);
  };

  // The work file plus the word list, the shape the review functions take.
  function work(id) {
    const w = store.readJson(id, 'work.json');
    if (!w) return null;
    return {...w, claude: store.readJson(id, 'ai.json', {}), wordList: words()};
  }

  const NOW = {Download: 'Downloading the speech engines', Speakers: 'Telling the voices apart', 'Word list': 'Checking the word list'};
  async function transcribe(job, engine, out, speakers) {
    let shown = '';
    const vocab = wordlist.vocabulary(words(), job.speakers || []);
    await speech.transcribe(engine, store.file(job.id, job.audio), out, {speakers, count: (job.speakers || []).length, vocab,
      onProgress: ({what, progress}) => {
        const label = NOW[what] || (engine === 'parakeet' ? 'Transcribing' : 'Checking with Whisper');
        const info = `${label}, ${Math.round(progress * 100)}%`;
        if (info !== shown) { shown = info; update(job, engine, {info}); }
      }});
  }

  const runners = {
    async download() { return {}; },
    // Parakeet's pass also says who is speaking; Whisper's is only a second opinion on the words.
    async parakeet(job) {
      const out = store.file(job.id, 'asr', 'parakeet.json');
      if (!fs.existsSync(out)) await transcribe(job, 'parakeet', out, true);
      return {info: null};
    },
    async whisper(job) {
      const out = store.file(job.id, 'asr', 'whisper.json');
      if (!fs.existsSync(out)) await transcribe(job, 'whisper', out, false);
      return {info: null};
    },
    async compare(job) {
      const p = readAsr(fs.readFileSync(store.file(job.id, 'asr', 'parakeet.json'), 'utf8'));
      if (!p.words.length) throw new Error('Parakeet heard no words in this recording.');
      const wFile = store.file(job.id, 'asr', 'whisper.json');
      const {flags, stats} = fs.existsSync(wFile)
        ? compareEngines(p, readAsr(fs.readFileSync(wFile, 'utf8')))
        : {flags: [], stats: {whisperMissing: true}};
      store.writeJson(job.id, 'work.json', {transcript: p, flags, stats});
      if (!fs.existsSync(store.file(job.id, 'review.json'))) store.writeJson(job.id, 'review.json', emptyReview());
      return {info: `${flags.length} ${flags.length === 1 ? 'place' : 'places'} the engines disagree`};
    },
  };

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const id = queue.shift();
      const job = store.get(id);
      if (!job) continue;
      for (const step of STEPS) {
        if (job.steps[step]?.state === 'done') continue;
        if (step !== 'download' && job.steps.download?.state !== 'done') break;
        if (step === 'compare' && job.steps.parakeet?.state !== 'done') break;
        update(job, step, {state: 'running', startedAt: new Date().toISOString(), error: null, info: null});
        try {
          const r = await runners[step](job);
          update(job, step, {state: 'done', endedAt: new Date().toISOString(), ...r});
        } catch (e) {
          update(job, step, {state: 'error', endedAt: new Date().toISOString(), error: String(e.message || e)});
          // Whisper is a second opinion: without it the review still works, with no flags.
          if (step !== 'whisper') break;
        }
      }
    }
    busy = false;
  }

  function enqueue(id) {
    if (!queue.includes(id)) queue.push(id);
    pump();
  }

  // Run a step again, and everything after it. New words and flags clear every decision.
  function rerun(id, step) {
    const job = store.get(id);
    const from = STEPS.indexOf(step);
    if (!job || from < 0) return;
    for (const s of STEPS.slice(from)) {
      if (s === 'download') continue;
      job.steps[s] = {state: 'pending'};
      if (s === 'parakeet' || s === 'whisper') fs.rmSync(store.file(id, 'asr', `${s}.json`), {force: true});
    }
    store.writeJson(id, 'review.json', emptyReview());
    store.save(job);
    emit(job);
    enqueue(id);
  }

  // On launch, pick up anything interrupted or never finished.
  function resume() {
    for (const job of store.list()) {
      let changed = false;
      for (const s of STEPS) if (job.steps[s]?.state === 'running') { job.steps[s] = {state: 'pending'}; changed = true; }
      if (changed) store.save(job);
      if (STEPS.some(s => job.steps[s]?.state === 'pending')) enqueue(job.id);
    }
  }

  const idle = () => !busy && !queue.length;

  return {enqueue, rerun, resume, work, idle};
}

module.exports = {create};

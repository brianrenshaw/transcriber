// The speech engines the app carries (native/speech, built into the app as Contents/Resources/transcriber-speech): Parakeet
// with the speaker separation, and Whisper. Their models, about 1.1 GB, download once into <userData>/Models,
// at first launch or the first time a recording needs them, and the word list's model the first time a
// recording has one. The app downloads them itself and checks every file (models.js); the helper only loads
// them. There is one download at a time, and every job waits on it.

const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const Models = require('./models');

const DEV_HELPER = path.join(__dirname, '..', '..', 'native', 'speech', '.build', 'release', 'transcriber-speech');
const lastLine = s => s.trim().split('\n').filter(Boolean).pop() || '';

// fetch: the app passes Electron's, which uses the Mac's proxy settings; the command line uses Node's.
function create({userData, fetch = globalThis.fetch, onState = () => {}}) {
  const modelsDir = path.join(userData, 'Models');
  const listeners = new Set([onState]);
  let state = {state: 'unknown', progress: 0, what: '', error: null};
  let queue = Promise.resolve();

  // The built app keeps the helper in Contents/Resources; a checkout runs the one `npm run speech` builds.
  function helper() {
    const bundled = process.resourcesPath ? path.join(process.resourcesPath, 'transcriber-speech') : null;
    return [bundled, DEV_HELPER].find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
  }

  function set(patch) {
    state = {...state, ...patch};
    for (const fn of listeners) fn({...state});
  }

  // Runs the helper. Each JSON line it prints goes to onLine; a failure rejects with its last line of stderr.
  function run(args, onLine = () => {}) {
    return new Promise((resolve, reject) => {
      const bin = helper();
      if (!bin) return reject(new Error('The speech engines are missing from this copy of the app. Run npm run speech.'));
      const child = spawn(bin, [...args, '--models', modelsDir], {stdio: ['ignore', 'pipe', 'pipe']});
      let out = '', err = '';
      child.stdout.on('data', d => {
        out += d;
        for (let i = out.indexOf('\n'); i >= 0; i = out.indexOf('\n')) {
          const line = out.slice(0, i); out = out.slice(i + 1);
          try { onLine(JSON.parse(line)); } catch {}
        }
      });
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(lastLine(err) || `The speech engine stopped (exit ${code}).`))));
    });
  }

  async function status() {
    if (state.state === 'downloading') return {...state};
    if (!helper()) { set({state: 'unavailable'}); return {...state}; }
    const ready = !Models.missing(modelsDir).length;
    set({state: ready ? 'ready' : 'missing', progress: ready ? 1 : 0});
    return {...state};
  }

  // need: 'always' for the engines, 'wordlist' for those and the word list's model. Downloads queue, so a
  // second call waits for the first and then fetches only what is still missing.
  async function download(need) {
    if (!Models.missing(modelsDir, need).length) return;
    set({state: 'downloading', progress: 0, what: '', error: null});
    try {
      await Models.ensure(modelsDir, {need, fetch, onProgress: p => set(p)});
      set({state: 'ready', progress: 1, what: ''});
    } catch (e) {
      set({state: 'error', error: e.message});
      throw new Error(e instanceof Models.Mismatch
        ? `A speech model could not be used: ${e.message} Nothing of it was kept.`
        : `The speech models could not be downloaded: ${e.message} Check the internet connection and try again.`);
    }
  }

  function prepare(need = 'always') {
    const next = queue.catch(() => {}).then(() => download(need));
    queue = next;
    return next;
  }

  async function ensure(onProgress, need = 'always') {
    if (!Models.missing(modelsDir, need).length) return;
    const follow = s => { if (s.state === 'downloading') onProgress?.(s); };
    listeners.add(follow);
    try { await prepare(need); } finally { listeners.delete(follow); }
  }

  // engine: 'parakeet' or 'whisper'. count: how many people speak, when the person named them. vocab: the word
  // list as the engines take it (wordlist.vocabulary), written beside the transcript for the helper to read.
  // onProgress gets {what, progress} while models download and while it works.
  async function transcribe(engine, audio, outFile, {speakers = false, count = 0, vocab = null, onProgress} = {}) {
    // Only Parakeet rescores against the terms, with the second model.
    const need = engine === 'parakeet' && vocab?.terms?.length ? 'wordlist' : 'always';
    await ensure(s => onProgress?.({what: 'Download', progress: s.progress}), need);
    const tmp = outFile + '.tmp';
    fs.mkdirSync(path.dirname(outFile), {recursive: true});
    fs.rmSync(tmp, {force: true});
    const who = speakers ? ['--speakers', ...(count >= 2 ? ['--speaker-count', String(count)] : [])] : [];
    let words = [];
    if (vocab && (vocab.prompt || vocab.terms?.length)) {
      const file = path.join(path.dirname(outFile), 'vocab.json');
      fs.writeFileSync(file, JSON.stringify(vocab, null, 1));
      words = ['--vocab', file];
    }
    await run([engine, ...who, ...words, audio, tmp], l => { if (typeof l.progress === 'number') onProgress?.(l); });
    if (!fs.existsSync(tmp) || !fs.statSync(tmp).size) throw new Error(`${engine === 'parakeet' ? 'Parakeet' : 'Whisper'} wrote no transcript.`);
    fs.renameSync(tmp, outFile);
  }

  return {status, prepare, ensure, transcribe, helper, modelsDir, state: () => ({...state}),
    listen: fn => { listeners.add(fn); return () => listeners.delete(fn); }};
}

module.exports = {create};

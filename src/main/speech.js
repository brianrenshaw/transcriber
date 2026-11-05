// The speech engines the app carries (native/speech, built into the app as Contents/Resources/transcriber-speech): Parakeet
// with the speaker separation, and Whisper. Their models, about 1.1 GB, download once into <userData>/Models,
// at first launch or the first time a recording needs them. There is one download at a time, and every job
// waits on it.

const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

const DEV_HELPER = path.join(__dirname, '..', '..', 'native', 'speech', '.build', 'release', 'transcriber-speech');
const lastLine = s => s.trim().split('\n').filter(Boolean).pop() || '';

function create({userData, onState = () => {}}) {
  const modelsDir = path.join(userData, 'Models');
  const listeners = new Set([onState]);
  let state = {state: 'unknown', progress: 0, what: '', error: null};
  let preparing = null;

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
    let ready = false;
    await run(['status'], l => { if ('ready' in l) ready = Boolean(l.ready); }).catch(() => {});
    set({state: ready ? 'ready' : 'missing', progress: ready ? 1 : 0});
    return {...state};
  }

  function prepare() {
    if (!preparing) {
      set({state: 'downloading', progress: 0, what: 'Parakeet', error: null});
      preparing = run(['prepare'], l => { if (typeof l.progress === 'number') set({progress: l.progress, what: l.what}); })
        .then(() => set({state: 'ready', progress: 1, what: ''}))
        .catch(e => {
          set({state: 'error', error: e.message});
          throw new Error(`The speech engines could not be downloaded: ${e.message} Check the internet connection and try again.`);
        })
        .finally(() => { preparing = null; });
    }
    return preparing;
  }

  async function ensure(onProgress) {
    if (state.state !== 'ready' && (await status()).state === 'ready') return;
    if (state.state === 'ready') return;
    const follow = s => { if (s.state === 'downloading') onProgress?.(s); };
    listeners.add(follow);
    try { await prepare(); } finally { listeners.delete(follow); }
  }

  // engine: 'parakeet' or 'whisper'. count: how many people speak, when the person named them. vocab: the word
  // list as the engines take it (wordlist.vocabulary), written beside the transcript for the helper to read.
  // onProgress gets {what, progress} while models download and while it works.
  async function transcribe(engine, audio, outFile, {speakers = false, count = 0, vocab = null, onProgress} = {}) {
    await ensure(s => onProgress?.({what: 'Download', progress: s.progress}));
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

// Transcripts on disk, one folder each. The folders are the truth; anything else (the library index, to come)
// is a cache rebuilt from them.
//   job.json       title, audio file name, the names typed for the speakers, step states
//   audio.<ext>    a copy of the recording
//   asr/           the two engines' raw JSON
//   work.json      the base transcript (Parakeet's words and segments), the flags, comparison stats
//   review.json    the person's decisions
// Every write goes to a temporary file first and is renamed into place, so a crash never leaves half a file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 'download' is done for a file from this Mac; it is there so a link can fill it in later.
const STEPS = ['download', 'parakeet', 'whisper', 'compare'];
const AUDIO = new Set(['.mp3', '.m4a', '.wav', '.aac', '.aif', '.aiff', '.flac', '.ogg', '.opus', '.mp4', '.mov', '.m4v']);

function create(rootFn) {
  const root = () => { const r = rootFn(); fs.mkdirSync(r, {recursive: true}); return r; };
  const dir = id => {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('Bad job id');
    return path.join(root(), id);
  };

  function readJson(id, name, fallback = null) {
    try { return JSON.parse(fs.readFileSync(path.join(dir(id), name), 'utf8')); } catch { return fallback; }
  }
  function writeJson(id, name, data) {
    const f = path.join(dir(id), name), tmp = `${f}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(f), {recursive: true});
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, f);
  }

  function list() {
    return fs.readdirSync(root(), {withFileTypes: true}).filter(d => d.isDirectory())
      .map(d => { try { return readJson(d.name, 'job.json'); } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Names typed when adding a recording ("Ada Park, Sam Ortiz"): how many voices to listen for, and words the
  // engines should expect.
  const people = text => String(text || '').split(/[,;\n]|\s+and\s+/).map(s => s.trim()).filter(Boolean).slice(0, 12);

  function add(audioPath, {speakers} = {}) {
    const ext = path.extname(audioPath).toLowerCase();
    if (!AUDIO.has(ext)) throw new Error(`${path.basename(audioPath)} isn't an audio or video file`);
    const now = new Date();
    const id = newId(now);
    fs.mkdirSync(dir(id), {recursive: true});
    // A clone where the disk can make one (APFS), so a long recording costs no extra space or time.
    fs.copyFileSync(audioPath, path.join(dir(id), `audio${ext}`), fs.constants.COPYFILE_FICLONE);
    const job = {id, title: path.basename(audioPath, path.extname(audioPath)), audio: `audio${ext}`,
      file: path.basename(audioPath), speakers: people(speakers), createdAt: now.toISOString(),
      steps: Object.fromEntries(STEPS.map(s => [s, {state: s === 'download' ? 'done' : 'pending'}]))};
    writeJson(id, 'job.json', job);
    return job;
  }

  function newId(now) {
    const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
  }

  const get = id => readJson(id, 'job.json');
  const save = job => { writeJson(job.id, 'job.json', job); return job; };
  const file = (id, ...parts) => path.join(dir(id), ...parts);

  return {list, add, get, save, readJson, writeJson, file, dir, root};
}

module.exports = {create, STEPS, AUDIO};

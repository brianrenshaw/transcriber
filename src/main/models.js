// The speech models, downloaded by the app itself and checked file by file. models.json (written by
// scripts/models.js) pins each set to one Hugging Face repo at one commit and lists every file the app takes from
// it, with its size and SHA-256. A file is downloaded from that commit only and kept only if it matches; a set
// counts as downloaded once every file in it has matched, which verified.json in the Models folder records.
// The speech helper only loads what is here: it never downloads anything itself.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HUB = 'https://huggingface.co';
const ATTEMPTS = 3;
const MARKER = '.fluidaudio-revision';

const pinned = () => require('./models.json');

// 'always' is Parakeet, Whisper and the speakers, which every recording needs; 'wordlist' adds the second, small
// model the word list needs, downloaded the first time a recording has one.
const setsFor = (need, manifest) => manifest.sets.filter(s => s.need === 'always' || s.need === need);

// A set's identity: a new commit or any changed file means it is checked, and downloaded where it differs, again.
const setId = s => crypto.createHash('sha256').update(JSON.stringify([s.repo, s.commit, s.from || '', s.to, Boolean(s.marker), s.files])).digest('hex');

function inside(root, rel) {
  const p = path.resolve(root, rel);
  if (!p.startsWith(path.resolve(root) + path.sep)) throw new Error(`A model file would land outside its folder: ${rel}`);
  return p;
}

const verifiedFile = dir => path.join(dir, 'verified.json');
function verified(dir) {
  try { return JSON.parse(fs.readFileSync(verifiedFile(dir), 'utf8')); } catch { return {}; }
}
function record(dir, key, id) {
  const tmp = verifiedFile(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({...verified(dir), [key]: id}, null, 1));
  fs.renameSync(tmp, verifiedFile(dir));
}

// The sets still to download for `need`.
function missing(dir, need = 'always', manifest = pinned()) {
  const v = verified(dir);
  return setsFor(need, manifest).filter(s => v[s.to] !== setId(s));
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

async function matches(file, f) {
  try { if (fs.statSync(file).size !== f.size) return false; } catch { return false; }
  return (await hashFile(file)) === f.sha256;
}

const fileUrl = (s, f) => `${HUB}/${s.repo}/resolve/${s.commit}/${[s.from, f.path].filter(Boolean).join('/').split('/').map(encodeURIComponent).join('/')}`;

class Mismatch extends Error {}

// One file into a .part beside it, hashed as it arrives; it takes its real name only once it matches.
async function download(url, dest, f, fetch, onBytes) {
  const part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  const res = await fetch(url, {redirect: 'follow'});
  if (!res.ok) throw new Error(`${f.path}: the server answered ${res.status}.`);
  if (res.url && new URL(res.url).protocol !== 'https:') throw new Error(`${f.path}: the download left HTTPS.`);
  const hash = crypto.createHash('sha256');
  const out = await fs.promises.open(part, 'w');
  let n = 0;
  try {
    const reader = res.body.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      n += r.value.length;
      if (n > f.size) throw new Mismatch(`${f.path} is larger than the copy this version of Transcriber was checked against.`);
      hash.update(r.value);
      await out.write(r.value);
      onBytes(n);
    }
    await out.close();
    if (n !== f.size || hash.digest('hex') !== f.sha256) throw new Mismatch(`${f.path} does not match the copy this version of Transcriber was checked against.`);
  } catch (e) {
    await out.close().catch(() => {});
    fs.rmSync(part, {force: true});
    throw e;
  }
  fs.renameSync(part, dest);
}

// Downloads what `need` still lacks into dir. Files already there that match are kept, so an interrupted download
// carries on where it stopped. onProgress gets {what, progress} with progress 0 to 1 over all of it. A network
// failure is tried again; a file that arrives but does not match is not, and nothing of it is kept.
async function ensure(dir, {need = 'always', fetch = globalThis.fetch, onProgress = () => {}, manifest = pinned()} = {}) {
  const todo = missing(dir, need, manifest);
  if (!todo.length) return false;
  const total = todo.reduce((a, s) => a + s.files.reduce((b, f) => b + f.size, 0), 0) || 1;
  // A tenth of a percent at most, so the window is not sent a message for every chunk.
  let done = 0, shown = '';
  const report = (what, bytes) => {
    const progress = Math.floor((bytes / total) * 1000) / 1000;
    if (`${what} ${progress}` !== shown) { shown = `${what} ${progress}`; onProgress({what, progress}); }
  };
  fs.mkdirSync(dir, {recursive: true});
  for (const s of todo) {
    const root = path.join(dir, s.to);
    for (const f of s.files) {
      const dest = inside(root, f.path);
      report(s.name, done);
      if (!(await matches(dest, f))) {
        for (let i = 1; ; i++) {
          try { await download(fileUrl(s, f), dest, f, fetch, n => report(s.name, done + n)); break; }
          catch (e) { if (e instanceof Mismatch || i >= ATTEMPTS) throw e; }
        }
      }
      done += f.size;
    }
    // FluidAudio takes a pinned repo's folder as its own only beside a marker naming the commit.
    if (s.marker) fs.writeFileSync(path.join(root, MARKER), s.commit);
    record(dir, s.to, setId(s));
  }
  report('Ready', total);
  return true;
}

module.exports = {ensure, missing, hashFile, setId, Mismatch};

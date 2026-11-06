// The speech models the app downloads, pinned. Each set below is one Hugging Face repo at one commit; this
// script lists every file the app takes from it, with its size and SHA-256, in src/main/models.json. The app
// downloads only those files, only from that commit, and keeps a file only if it matches (src/main/models.js).
//
//   node scripts/models.js                                   write src/main/models.json from the pins below
//   node scripts/models.js --list <repo> <commit> [folder]   a repo's files at a commit, by folder
//   node scripts/models.js --check <Models folder>           compare a downloaded Models folder with models.json
//
// To move to newer models: change a commit below, run this, transcribe a few recordings, and commit the new
// models.json with it. A repo FluidAudio pins itself (`revision` in FluidAudio's ModelNames.swift) has to use
// FluidAudio's commit, with marker: true, or FluidAudio will not take the files as its own.
//
// The SHA-256 of a large file is the one Hugging Face stores for it (its LFS oid). A small file is downloaded
// from the commit and hashed here, after checking that it is the file the commit names (its git blob id).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {hashFile} = require('../src/main/models');

const HUB = 'https://huggingface.co';
const OUT = path.join(__dirname, '..', 'src', 'main', 'models.json');

// name: what the download shows. need: 'always', or 'wordlist' for the model only a word list uses.
// from: the folder in the repo. to: the folder under Models, where the helper looks (native/speech).
// take: the files and folders to take, all if absent. For FluidAudio's repos that is the compiled models it
// loads and the .json files at the repo's root, which FluidAudio always takes with them.
const PINS = [
  {name: 'Parakeet', need: 'always', repo: 'FluidInference/parakeet-tdt-0.6b-v3-coreml', commit: '7dd20fe6b1797d35f5e3307e8b1732d9a178edfe',
    to: 'parakeet-tdt-0.6b-v3',
    take: ['Preprocessor.mlmodelc/', 'Encoder.mlmodelc/', 'Decoder.mlmodelc/', 'JointDecisionv3.mlmodelc/', 'config.json', 'parakeet_v3_vocab.json', 'parakeet_vocab.json']},
  {name: 'Whisper', need: 'always', repo: 'argmaxinc/whisperkit-coreml', commit: '0f63a7800b00dd0226abd051b906c246e1907482',
    from: 'openai_whisper-large-v3-v20240930_626MB', to: 'whisper/openai_whisper-large-v3-v20240930_626MB'},
  // Whisper's tokenizer, which WhisperKit would otherwise fetch on first use, unpinned, into ~/Documents.
  {name: 'Whisper', need: 'always', repo: 'openai/whisper-large-v3', commit: '06f233fe06e710322aca913c1bc4249a0d71fce1',
    to: 'whisper/tokenizer', take: ['tokenizer.json', 'tokenizer_config.json', 'config.json']},
  {name: 'Speakers', need: 'always', repo: 'FluidInference/speaker-diarization-coreml', commit: 'df2625ac79a7ac6b65ad868fee6d80f320da4232',
    to: 'speakers/speaker-diarization', marker: true,
    take: ['Segmentation.mlmodelc/', 'Embedding.mlmodelc/', 'FBank.mlmodelc/', 'PldaRho.mlmodelc/', 'config.json', 'plda-parameters.json', 'provenance.json', 'xvector-transform.json']},
  {name: 'Word list', need: 'wordlist', repo: 'FluidInference/parakeet-ctc-110m-coreml', commit: 'accdafd8cf8a2ff1cabe3c11e54416b405d409aa',
    to: 'ctc/parakeet-ctc-110m-coreml',
    take: ['MelSpectrogram.mlmodelc/', 'AudioEncoder.mlmodelc/', 'config.json', 'ctc_head_metadata.json', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json']},
];

const usage = () => { console.error('usage: node scripts/models.js [--list <repo> <commit> [folder] | --check <Models folder>]'); process.exit(2); };

async function get(url) {
  const res = await fetch(url, {redirect: 'follow'});
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
}

// Every file under `folder` at `commit`, following the API's pages.
async function tree(repo, commit, folder = '') {
  let url = `${HUB}/api/models/${repo}/tree/${commit}/${folder}?recursive=true`;
  const files = [];
  while (url) {
    const res = await get(url);
    files.push(...(await res.json()).filter(e => e.type === 'file'));
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '')?.[1] || null;
  }
  return files;
}

async function list(repo, commit, folder = '') {
  const by = new Map();
  for (const f of await tree(repo, commit, folder)) {
    const rel = folder ? f.path.slice(folder.length + 1) : f.path;
    const key = rel.includes('/') ? rel.split('/')[0] + '/' : rel;
    const [n, size] = by.get(key) || [0, 0];
    by.set(key, [n + 1, size + f.size]);
  }
  for (const [key, [n, size]] of [...by].sort()) console.log(`${key.padEnd(64)} ${String(n).padStart(4)} files ${(size / 1e6).toFixed(1).padStart(9)} MB`);
}

const gitBlob = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

async function pin(p) {
  const all = await tree(p.repo, p.commit, p.from || '');
  const rel = f => (p.from ? f.path.slice(p.from.length + 1) : f.path);
  const taken = all.filter(f => !p.take || p.take.some(t => (t.endsWith('/') ? rel(f).startsWith(t) : rel(f) === t)));
  for (const t of p.take || []) if (!taken.some(f => (t.endsWith('/') ? rel(f).startsWith(t) : rel(f) === t))) throw new Error(`${p.repo}@${p.commit} has no ${t}`);
  const files = [];
  for (const f of taken.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    let sha256 = f.lfs?.oid;
    if (!sha256) {
      const buf = Buffer.from(await (await get(`${HUB}/${p.repo}/resolve/${p.commit}/${f.path.split('/').map(encodeURIComponent).join('/')}`)).arrayBuffer());
      if (gitBlob(buf) !== f.oid) throw new Error(`${f.path} downloaded from ${p.commit} is not the file the commit names`);
      sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${f.path} has no SHA-256`);
    files.push({path: rel(f), size: f.size, sha256});
  }
  const {take, ...set} = p;
  return {...set, files};
}

async function write() {
  const sets = [];
  for (const p of PINS) {
    const set = await pin(p);
    console.log(`${p.name.padEnd(10)} ${p.repo}@${p.commit.slice(0, 7)}  ${set.files.length} files, ${(set.files.reduce((a, f) => a + f.size, 0) / 1e6).toFixed(0)} MB`);
    sets.push(set);
  }
  const about = 'Written by scripts/models.js. Every speech model file the app downloads: from which repo, at which commit, and the size and SHA-256 it must have.';
  // One file to a line, so a new commit shows as a readable diff.
  const set = ({files, ...rest}) => `  ${JSON.stringify(rest).slice(0, -1)}, "files": [\n${files.map(f => `   ${JSON.stringify(f)}`).join(',\n')}\n  ]}`;
  fs.writeFileSync(OUT, `{"about": ${JSON.stringify(about)},\n "sets": [\n${sets.map(set).join(',\n')}\n ]}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
}

async function check(dir) {
  const {sets} = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  let bad = 0;
  for (const s of sets) {
    let ok = 0, missing = 0;
    for (const f of s.files) {
      const file = path.join(dir, s.to, f.path);
      if (!fs.existsSync(file)) { missing++; continue; }
      if (fs.statSync(file).size === f.size && (await hashFile(file)) === f.sha256) ok++;
      else { bad++; console.log(`  differs: ${s.to}/${f.path}`); }
    }
    console.log(`${s.name.padEnd(10)} ${s.to}: ${ok} match, ${missing} missing, ${s.files.length - ok - missing} differ`);
  }
  process.exitCode = bad ? 1 : 0;
}

const [flag, ...args] = process.argv.slice(2);
(flag === '--list' ? (args.length >= 2 ? list(...args) : usage())
  : flag === '--check' ? (args[0] ? check(args[0]) : usage())
    : flag ? usage() : write()
).catch(e => { console.error(e.message || e); process.exit(1); });

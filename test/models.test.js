// The model downloads: every file from its pinned commit, kept only if its SHA-256 matches, an interrupted
// download carried on, and nothing kept of a file that does not match. A fake fetch stands in for Hugging Face.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Models = require('../src/main/models');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const COMMIT = 'a'.repeat(40);
const blobs = {'Enc.mlmodelc/weights/weight.bin': Buffer.alloc(300000, 7), 'config.json': Buffer.from('{"a":1}'), 'vocab.json': Buffer.from('["x"]')};
const entry = p => ({path: p, size: blobs[p].length, sha256: sha(blobs[p])});
const manifest = {sets: [
  {name: 'Engine', need: 'always', repo: 'org/engine', commit: COMMIT, to: 'engine', files: [entry('Enc.mlmodelc/weights/weight.bin'), entry('config.json')]},
  {name: 'Pinned', need: 'always', repo: 'org/pinned', commit: COMMIT, from: 'sub', to: 'pinned/p', marker: true, files: [entry('config.json')]},
  {name: 'Word list', need: 'wordlist', repo: 'org/ctc', commit: COMMIT, to: 'ctc', files: [entry('vocab.json')]},
]};

// Serves each file at its pinned URL in small chunks; `swap` serves other bytes for a path, `fail` fails a
// path's first n requests.
function fakeHub({swap = {}, fail = {}} = {}) {
  const asked = [];
  const fetch = async url => {
    asked.push(url);
    const m = /^https:\/\/huggingface\.co\/(org\/\w+)\/resolve\/([0-9a-f]{40})\/(.+)$/.exec(url);
    if (!m || m[2] !== COMMIT) return new Response('not found', {status: 404});
    const rel = decodeURIComponent(m[3]).replace(/^sub\//, '');
    if (fail[rel] > 0) { fail[rel]--; throw new TypeError('fetch failed'); }
    const body = swap[rel] || blobs[rel];
    if (!body) return new Response('not found', {status: 404});
    return new Response(new ReadableStream({start(c) { for (let i = 0; i < body.length; i += 65536) c.enqueue(body.subarray(i, i + 65536)); c.close(); }}));
  };
  return {fetch, asked};
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-models-'));

test('downloads every file into its folder, then counts the sets as done', async () => {
  const dir = tmp(), hub = fakeHub(), seen = [];
  assert.strictEqual(Models.missing(dir, 'always', manifest).length, 2);
  assert.strictEqual(await Models.ensure(dir, {fetch: hub.fetch, manifest, onProgress: p => seen.push(p)}), true);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'engine/Enc.mlmodelc/weights/weight.bin')), blobs['Enc.mlmodelc/weights/weight.bin']);
  assert.ok(fs.existsSync(path.join(dir, 'pinned/p/config.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'ctc')), 'the word list model waits until a word list needs it');
  assert.deepStrictEqual(Models.missing(dir, 'always', manifest), []);
  assert.ok(hub.asked.every(u => u.includes(`/resolve/${COMMIT}/`)), 'only from the pinned commit');
  assert.ok(hub.asked.includes(`https://huggingface.co/org/pinned/resolve/${COMMIT}/sub/config.json`));
  const ps = seen.map(p => p.progress);
  assert.deepStrictEqual(ps, [...ps].sort((a, b) => a - b), 'progress only goes forward');
  assert.deepStrictEqual(seen.at(-1), {what: 'Ready', progress: 1});
  assert.strictEqual(await Models.ensure(dir, {fetch: hub.fetch, manifest}), false, 'nothing to do the second time');
});

test('writes the revision marker FluidAudio needs beside a pinned repo', async () => {
  const dir = tmp();
  await Models.ensure(dir, {fetch: fakeHub().fetch, manifest});
  assert.strictEqual(fs.readFileSync(path.join(dir, 'pinned/p/.fluidaudio-revision'), 'utf8'), COMMIT);
  assert.ok(!fs.existsSync(path.join(dir, 'engine/.fluidaudio-revision')));
});

test('a file that does not match is not kept, not retried, and the set stays missing', async () => {
  const dir = tmp(), hub = fakeHub({swap: {'config.json': Buffer.from('{"a":2}')}});
  await assert.rejects(Models.ensure(dir, {fetch: hub.fetch, manifest}), e => e instanceof Models.Mismatch && /config\.json/.test(e.message));
  assert.ok(!fs.existsSync(path.join(dir, 'engine/config.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'engine/config.json.part')));
  assert.strictEqual(hub.asked.filter(u => u.endsWith('/config.json')).length, 1);
  assert.strictEqual(Models.missing(dir, 'always', manifest).length, 2);
});

test('a file larger than listed is stopped as it arrives', async () => {
  const dir = tmp(), big = Buffer.alloc(blobs['config.json'].length + 10, 1);
  await assert.rejects(Models.ensure(dir, {fetch: fakeHub({swap: {'config.json': big}}).fetch, manifest}), /larger/);
});

test('a network failure is tried again', async () => {
  const dir = tmp(), hub = fakeHub({fail: {'config.json': 2}});
  await Models.ensure(dir, {fetch: hub.fetch, manifest});
  assert.deepStrictEqual(Models.missing(dir, 'always', manifest), []);
});

test('gives up after three network failures', async () => {
  const dir = tmp();
  await assert.rejects(Models.ensure(dir, {fetch: fakeHub({fail: {'config.json': 3}}).fetch, manifest}), /fetch failed/);
});

test('an interrupted download keeps the files that already match', async () => {
  const dir = tmp(), first = fakeHub({fail: {'config.json': 3}});
  await assert.rejects(Models.ensure(dir, {fetch: first.fetch, manifest}));
  const again = fakeHub();
  await Models.ensure(dir, {fetch: again.fetch, manifest});
  assert.ok(!again.asked.some(u => u.endsWith('weight.bin')), 'the weights were not fetched twice');
});

test('a file changed on disk is fetched again before the set counts', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'engine'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'engine/config.json'), '{"a":9}');
  await Models.ensure(dir, {fetch: fakeHub().fetch, manifest});
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'engine/config.json')), blobs['config.json']);
});

test('the word list model comes when a word list needs it', async () => {
  const dir = tmp();
  await Models.ensure(dir, {fetch: fakeHub().fetch, manifest});
  assert.strictEqual(Models.missing(dir, 'wordlist', manifest).length, 1);
  await Models.ensure(dir, {need: 'wordlist', fetch: fakeHub().fetch, manifest});
  assert.deepStrictEqual(Models.missing(dir, 'wordlist', manifest), []);
});

test('a new commit counts as not yet downloaded', async () => {
  const dir = tmp();
  await Models.ensure(dir, {fetch: fakeHub().fetch, manifest});
  const moved = {sets: manifest.sets.map(s => (s.to === 'engine' ? {...s, commit: 'b'.repeat(40)} : s))};
  assert.deepStrictEqual(Models.missing(dir, 'always', moved).map(s => s.to), ['engine']);
});

test('a path that leaves its folder is refused', async () => {
  const bad = {sets: [{...manifest.sets[0], files: [{...entry('config.json'), path: '../../escape.json'}]}]};
  await assert.rejects(Models.ensure(tmp(), {fetch: fakeHub().fetch, manifest: bad}), /outside its folder/);
});

test('models.json pins every file: one commit per repo, a size and a SHA-256 each', () => {
  const {sets} = require('../src/main/models.json');
  assert.ok(sets.length >= 4);
  assert.strictEqual(new Set(sets.map(s => s.to)).size, sets.length);
  for (const s of sets) {
    assert.match(s.commit, /^[0-9a-f]{40}$/, s.to);
    assert.match(s.repo, /^[\w.-]+\/[\w.-]+$/, s.to);
    assert.ok(['always', 'wordlist'].includes(s.need), s.to);
    assert.ok(s.files.length, s.to);
    assert.strictEqual(new Set(s.files.map(f => f.path)).size, s.files.length, s.to);
    for (const f of s.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
      assert.ok(Number.isInteger(f.size) && f.size > 0, f.path);
      assert.ok(!f.path.split('/').includes('..') && !path.isAbsolute(f.path), f.path);
    }
  }
  const total = sets.filter(s => s.need === 'always').flatMap(s => s.files).reduce((a, f) => a + f.size, 0);
  assert.ok(total > 1.0e9 && total < 1.25e9, `the window says about 1.1 GB; the list adds up to ${(total / 1e9).toFixed(2)} GB`);
});

// Run recordings through the whole pipeline without the window, for testing on any machine.
//
//   node scripts/run-pipeline.js --home <dir> <recording>...
//
// --home is a folder for this run's settings, models and transcripts (like the app's userData); it keeps test
// transcripts out of the real ones. Open the result in the app with: TRANSCRIBER_HOME=<dir> npm start

const fs = require('node:fs');
const path = require('node:path');
const Settings = require('../src/main/settings');
const Store = require('../src/main/store');
const Pipeline = require('../src/main/pipeline');
const Speech = require('../src/main/speech');

const args = process.argv.slice(2);
let home = null;
const recordings = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--home') home = args[++i];
  else recordings.push(args[i]);
}
if (!home || !recordings.length) {
  console.error('Usage: node scripts/run-pipeline.js --home <dir> <recording>...');
  process.exit(2);
}

home = path.resolve(home);
const settings = Settings.create(home);
const store = Store.create(() => settings.dataDir());
const words = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'word-list.json'), 'utf8')); } catch { return []; } };
const started = Date.now();
// The engines (npm run speech) keep their models under --home, like the app's userData.
const speech = Speech.create({userData: home});
const pipeline = Pipeline.create({store, speech, words, emit: job => {
  const line = Object.entries(job.steps).map(([k, v]) => `${k}:${v.state}${v.info ? ` (${v.info})` : ''}`).join('  ');
  console.log(`${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s  ${job.title}  ${line}`);
  for (const [k, v] of Object.entries(job.steps)) if (v.state === 'error') console.log(`      ${k} failed: ${v.error}`);
}});

(async () => {
  const ids = [];
  for (const r of recordings) {
    const job = store.add(r);
    ids.push(job.id);
    pipeline.enqueue(job.id);
  }
  while (!pipeline.idle()) await new Promise(r => setTimeout(r, 500));
  for (const id of ids) {
    const job = store.get(id), w = pipeline.work(id);
    console.log(`\n${job.title} (${store.dir(id)})`);
    if (!w) continue;
    console.log(`  ${w.transcript.words.length} words, ${w.flags.length} flags, agreement ${(w.stats.agreement * 100).toFixed(1)}%` +
      (w.transcript.speakers?.length ? `, voices ${w.transcript.speakers.map(v => `${v.label} ${Math.round(v.share * 100)}%`).join(', ')}` : ''));
  }
})().catch(e => { console.error(e); process.exit(1); });

// Claude's suggestions: the prompt, both ways of asking (Claude Code and an API key, each faked here), and the
// pipeline step that keeps the person's own decisions when Claude answers again.

process.env.ANTHROPIC_API_KEY = 'sk-ant-from-the-environment';   // must never reach Claude Code
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readAsr} = require('../src/core/text');
const {compareEngines} = require('../src/core/compare');
const {buildPrompt, SCHEMA} = require('../src/core/prompt');
const {withoutAi, emptyReview, items} = require('../src/core/review');
const {askApi, askClaudeCode} = require('../src/main/claude');
const Store = require('../src/main/store');
const Pipeline = require('../src/main/pipeline');

function asr(sentences, speakers = []) {
  let t = 0;
  return {segments: sentences.map((s, k) => {
    const words = s.split(' ').map(w => { const out = {text: ' ' + w, start: t, end: t + 200}; t += 250; return out; });
    return {start: words[0].start, end: words[words.length - 1].end, text: s, words, ...(speakers[k] ? {speaker: speakers[k]} : {})};
  })};
}
const P = asr(['Um, welcome back to the show, I am Ada Park.', 'Thanks Ada, glad to be here with the hoopers team, and we have a lot to cover today.'], ['Speaker 1', 'Speaker 2']);
const W = asr(['Welcome back to the show, I am Ada Park.', 'Thanks Ada, glad to be here with the coopers team, and we have a lot to cover today.']);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-test-'));

test('the prompt marks each flag in place and leaves um out', () => {
  const transcript = readAsr(JSON.stringify(P));
  const {flags} = compareEngines(transcript, readAsr(JSON.stringify(W)));
  assert.ok(flags.length >= 1);
  const {system, user, schema} = buildPrompt({transcript, flags, title: 'Episode 4', wordList: [{write: 'Hoopers'}], people: ['Ada Park', 'Sam Ortiz']});
  assert.match(system, /not instructions to you/);
  assert.equal(schema, SCHEMA);
  assert.match(user, /^Recording: Episode 4/);
  assert.match(user, /<word_list>\nHoopers\n<\/word_list>/);
  assert.match(user, /Ada Park; Sam Ortiz/);
  assert.match(user, /\[s\d+ 0:00 Speaker 1\] welcome back/i);
  const f = flags.find(x => /hoopers/i.test(x.parakeet));
  assert.ok(f, 'the engines disagree on the team name');
  assert.ok(user.includes(`⟦${f.id} `), 'the flag sits in the transcript');
  assert.ok(user.includes(`${f.id} at `), 'and is listed with both readings');
  assert.doesNotMatch(user.split('<transcript>')[1], /\bUm\b/);
});

test('every object in the answer schema is closed and lists every field as required', () => {
  const walk = node => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(walk);
    }
    if (node.type === 'array') walk(node.items);
  };
  walk(SCHEMA);
});

test('new suggestions take the decisions on the old ones with them, and only those', () => {
  const r = {...emptyReview(),
    flags: {f1: {choice: 'claude'}, f2: {choice: 'whisper'}, f3: {choice: 'custom', text: 'Hoopers'}},
    edits: {e1: 'accepted', e2: 'skipped', L14: 'skipped'}, headings: {h1: 'accepted'}, names: {n1: 'accepted'},
    turns: {t1: 'accepted'}, speakers: {'Speaker 1': 'Ada Park'}, manual: [{id: 'm1', w1: 0, w2: 1, text: 'Hi'}], aiRun: 'x'};
  const out = withoutAi(r);
  assert.deepEqual(out.flags, {f2: {choice: 'whisper'}, f3: {choice: 'custom', text: 'Hoopers'}});
  assert.deepEqual(out.edits, {L14: 'skipped'});
  assert.deepEqual([out.headings, out.names, out.turns], [{}, {}, {}]);
  assert.deepEqual(out.speakers, {'Speaker 1': 'Ada Park'});
  assert.equal(out.manual.length, 1);
});

// ---- the API key, with a fake client in place of Anthropic's

function fakeAnthropic(message, seen) {
  const stream = params => { seen.push(params); return {finalMessage: async () => message}; };
  return {messages: {stream: p => stream({...p, beta: false})}, beta: {messages: {stream: p => stream({...p, beta: true})}}};
}
const PROMPT = {system: 'S', user: 'U', schema: SCHEMA};
const ANSWER = {flags: [], edits: [], paragraphs: [], headings: [], speakers: [], speaker_fixes: []};

test('the API path asks for structured output, with the server-side fallback, and reads the answer', async () => {
  const seen = [];
  const msg = {model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: {input_tokens: 10, output_tokens: 5},
    content: [{type: 'thinking', thinking: ''}, {type: 'text', text: JSON.stringify(ANSWER)}]};
  const {output, meta} = await askApi(PROMPT, {model: '', anthropic: fakeAnthropic(msg, seen)});
  assert.deepEqual(output, ANSWER);
  assert.equal(meta.via, 'api-key');
  assert.deepEqual(meta.tokens, {input: 10, output: 5});
  const [p] = seen;
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.beta, true);
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.output_config.format, {type: 'json_schema', schema: SCHEMA});
  assert.equal(p.system, 'S');
  assert.deepEqual(p.messages, [{role: 'user', content: 'U'}]);
});

test('after a fallback only the last model’s words are the answer; Haiku goes without one', async () => {
  const seen = [];
  const msg = {model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: {},
    content: [{type: 'text', text: '{"flags": [{"id"'}, {type: 'fallback', from: {model: 'claude-opus-5-5'}, to: {model: 'claude-opus-4-8'}},
      {type: 'text', text: JSON.stringify(ANSWER)}]};
  const {output, meta} = await askApi(PROMPT, {model: 'claude-sonnet-5-5', anthropic: fakeAnthropic(msg, seen)});
  assert.deepEqual(output, ANSWER);
  assert.equal(meta.model, 'claude-opus-4-8');
  await askApi(PROMPT, {model: 'claude-haiku-5-5', anthropic: fakeAnthropic({...msg, content: [{type: 'text', text: '{}'}]}, seen)});
  assert.equal(seen[1].beta, false);
  assert.equal(seen[1].fallbacks, undefined);
});

test('a refusal, a cut-off answer and an unreadable one each say what happened', async () => {
  const ask = message => askApi(PROMPT, {model: '', anthropic: fakeAnthropic({usage: {}, content: [], ...message}, [])});
  await assert.rejects(ask({stop_reason: 'refusal'}), /declined/);
  await assert.rejects(ask({stop_reason: 'max_tokens'}), /length limit/);
  await assert.rejects(ask({stop_reason: 'end_turn', content: [{type: 'text', text: 'Sure! Here'}]}), /couldn’t read/);
});

// ---- Claude Code, with a script in place of the claude command

function fakeClaude({signedIn = true, result} = {}) {
  const dir = tmp(), bin = path.join(dir, 'claude'), log = path.join(dir, 'log.json');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({loggedIn: ${signedIn}, authMethod: 'claude.ai', email: 'ada@example.com', subscriptionType: 'pro'})); process.exit(0); }
let input = ''; process.stdin.on('data', d => input += d).on('end', () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({args, input, cwd: process.cwd(), key: process.env.ANTHROPIC_API_KEY || null}));
  console.log(JSON.stringify(${JSON.stringify(result ?? {type: 'result', is_error: false, structured_output: ANSWER, duration_ms: 1200,
    modelUsage: {'claude-haiku-5-5': {outputTokens: 20}, 'claude-opus-5-5': {outputTokens: 900}}})}));
});
`, {mode: 0o755});
  return {bin, dir, log: () => JSON.parse(fs.readFileSync(log, 'utf8'))};
}

test('Claude Code gets the prompt on stdin with no tools or settings, and none of the API variables', async () => {
  const c = fakeClaude();
  const {output, meta} = await askClaudeCode({system: 'S', user: 'the transcript', schema: SCHEMA}, {model: 'claude-sonnet-5-5', cwd: c.dir, bin: c.bin});
  assert.deepEqual(output, ANSWER);
  assert.deepEqual(meta, {via: 'claude-code', model: 'claude-opus-5-5', ms: 1200}, 'which Claude, not whose account');
  const run = c.log();
  assert.equal(run.input, 'the transcript');
  assert.equal(run.key, null);
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(c.dir));
  const at = flag => run.args[run.args.indexOf(flag) + 1];
  assert.equal(run.args[0], '-p');
  assert.equal(at('--tools'), '');
  assert.equal(at('--setting-sources'), '');
  assert.ok(run.args.includes('--no-session-persistence'));
  assert.equal(at('--system-prompt'), 'S');
  assert.deepEqual(JSON.parse(at('--json-schema')), SCHEMA);
  assert.equal(at('--model'), 'claude-sonnet-5-5');
});

test('Claude Code that is signed out, or answers with an error, says so', async () => {
  await assert.rejects(askClaudeCode(PROMPT, {cwd: tmp(), bin: fakeClaude({signedIn: false}).bin}), /isn’t signed in/);
  const c = fakeClaude({result: {type: 'result', is_error: true, result: 'Credit balance is too low'}});
  await assert.rejects(askClaudeCode(PROMPT, {cwd: c.dir, bin: c.bin}), /Credit balance is too low/);
});

// ---- the pipeline step

function pipelineWith(ai) {
  const root = tmp(), store = Store.create(() => root);
  const speech = {transcribe: async (engine, _audio, out) => {
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(out, JSON.stringify(engine === 'parakeet' ? P : W));
  }};
  const pipeline = Pipeline.create({store, speech, ai});
  const audio = path.join(root, 'Episode 4.wav');
  fs.writeFileSync(audio, 'RIFF');
  const job = store.add(audio);
  return {store, pipeline, job};
}
const until = async test => { for (let i = 0; i < 200 && !test(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(test()); };

test('with Claude off the step waits, nothing is asked, and the transcript is ready', async () => {
  let asked = 0;
  const {store, pipeline, job} = pipelineWith({mode: () => 'off', ask: async () => { asked++; }});
  pipeline.enqueue(job.id);
  await until(() => store.get(job.id).steps.ai?.state === 'off');
  assert.equal(store.get(job.id).steps.compare.state, 'done');
  assert.equal(asked, 0);
  assert.equal(store.readJson(job.id, 'ai.json'), null);
  pipeline.rerun(job.id, 'ai');
  assert.equal(store.get(job.id).steps.ai.state, 'off', 'asking needs Claude turned on');
});

test('with Claude on, its suggestions land as their own run, and asking again keeps the person’s choices', async () => {
  let n = 0;
  const ai = {mode: () => 'claude-code', ask: async ({user}) => {
    n++;
    const id = /⟦(f\d+) /.exec(user)[1];
    return {output: {...ANSWER, flags: [{id, choice: 'whisper', text: 'Hoopers', confidence: 'high', reason: `Run ${n}.`, evidence: []}]},
      meta: {via: 'claude-code', model: 'claude-opus-5-5'}};
  }};
  const {store, pipeline, job} = pipelineWith(ai);
  pipeline.enqueue(job.id);
  await until(() => store.get(job.id).steps.ai?.state === 'done');
  const first = store.readJson(job.id, 'ai.json');
  assert.equal(Object.values(first.picks)[0].reason, 'Run 1.');
  assert.equal(store.readJson(job.id, 'review.json').aiRun, first.meta.run);
  assert.ok(pipeline.idle());

  // The person takes Claude's reading on one flag and Whisper's on another (here the same id, then a fake one).
  const [fid] = Object.keys(first.picks);
  store.writeJson(job.id, 'review.json', {...store.readJson(job.id, 'review.json'), flags: {[fid]: {choice: 'claude'}, f99: {choice: 'whisper'}}});
  await new Promise(r => setTimeout(r, 5));
  pipeline.rerun(job.id, 'ai');
  await until(() => store.get(job.id).steps.ai?.state === 'done' && store.readJson(job.id, 'ai.json').meta.run !== first.meta.run);
  const second = store.readJson(job.id, 'ai.json'), review = store.readJson(job.id, 'review.json');
  assert.equal(Object.values(second.picks)[0].reason, 'Run 2.');
  assert.deepEqual(review.flags, {f99: {choice: 'whisper'}}, 'the decision on the old suggestion went; the engine choice stayed');
  assert.equal(review.aiRun, second.meta.run);
  const w = pipeline.work(job.id);
  assert.ok(items(w, review).some(it => it.type === 'flag' && it.pick?.reason === 'Run 2.'));
});

test('transcribing again clears Claude’s suggestions with the words they were about', async () => {
  const ai = {mode: () => 'api-key', ask: async () => ({output: ANSWER, meta: {via: 'api-key', model: 'claude-opus-5-5'}})};
  const {store, pipeline, job} = pipelineWith(ai);
  pipeline.enqueue(job.id);
  await until(() => store.get(job.id).steps.ai?.state === 'done');
  ai.mode = () => 'off';
  pipeline.rerun(job.id, 'parakeet');
  assert.equal(store.readJson(job.id, 'ai.json'), null);
  await until(() => store.get(job.id).steps.ai?.state === 'off');
});

test('a failed answer leaves the transcript ready and the step to try again', async () => {
  const {store, pipeline, job} = pipelineWith({mode: () => 'api-key', ask: async () => { throw new Error('Couldn’t reach Anthropic.'); }});
  pipeline.enqueue(job.id);
  await until(() => store.get(job.id).steps.ai?.state === 'error');
  const steps = store.get(job.id).steps;
  assert.equal(steps.compare.state, 'done');
  assert.equal(steps.ai.error, 'Couldn’t reach Anthropic.');
});

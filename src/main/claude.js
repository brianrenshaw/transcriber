// Claude's suggestions, through the person's own Claude: their Claude Code sign-in (the claude command they
// installed, run on their account) or their own Anthropic API key. The app has no Claude account of its own
// and never sees a password. What goes is text only, as src/core/prompt.js builds it.

const {spawn, execFile} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODELS = [
  {id: 'claude-opus-5-5', name: 'Claude Opus 5.5'},
  {id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5'},
  {id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5'},
];
const API_DEFAULT = 'claude-opus-5-5';
const known = id => MODELS.some(m => m.id === id);

// ---- Claude Code

const HOME = os.homedir();
const DIRS = [path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.claude', 'local')];
// Claude Code runs on the account it is signed in to. These would send it somewhere else (an API key, a cloud
// provider), so they never reach it from this app.
const API_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AWS_BEARER_TOKEN_BEDROCK'];
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !API_VARS.includes(k)));
ENV.PATH = [...new Set([...DIRS, ...(process.env.PATH || '/usr/bin:/bin').split(':')])].join(':');

const isExe = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

// An app opened from the Finder gets a short PATH, so the usual install folders are tried first, then the
// person's login shell.
let found = null;
async function findClaude() {
  if (found && isExe(found)) return found;
  found = DIRS.map(d => path.join(d, 'claude')).find(isExe) || await new Promise(resolve =>
    execFile('/bin/zsh', ['-lc', 'command -v claude'], {timeout: 5000, env: ENV}, (err, out) => {
      const p = String(out || '').trim().split('\n').pop() || '';
      resolve(!err && p.startsWith('/') && isExe(p) ? p : null);
    }));
  return found;
}

const running = new Set();
function run(cmd, args, {input = '', timeout = 15000, cwd} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {cwd, env: ENV, stdio: ['pipe', 'pipe', 'pipe']});
    running.add(child);
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    const end = () => { clearTimeout(timer); running.delete(child); };
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { end(); reject(e); });
    child.on('close', (code, signal) => { end(); resolve({code, signal, out, err}); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const firstLine = s => String(s || '').trim().split('\n').find(l => l.trim()) || '';
const lastJson = s => {
  for (const line of [String(s || '').trim(), ...String(s || '').trim().split('\n').reverse()]) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
};

// bin: the claude command, when the caller already has it.
async function claudeCodeStatus(bin) {
  bin = bin || await findClaude();
  if (!bin) return {installed: false, signedIn: false};
  const r = await run(bin, ['auth', 'status'], {timeout: 15000}).catch(() => null);
  const s = lastJson(r?.out);
  if (!s) return {installed: true, signedIn: false, error: 'Claude Code didn’t say whether it’s signed in.'};
  return {installed: true, signedIn: Boolean(s.loggedIn), email: s.email || '', plan: s.subscriptionType || '', method: s.authMethod || ''};
}

async function askClaudeCode({system, user, schema}, {model, cwd, bin}) {
  bin = bin || await findClaude();
  if (!bin) throw new Error('Claude Code isn’t installed. Settings can install it.');
  const status = await claudeCodeStatus(bin);
  if (!status.signedIn) throw new Error('Claude Code isn’t signed in. Settings can sign you in.');
  // No tools, no settings files, no CLAUDE.md, no saved session: one question in, one structured answer out.
  const args = ['-p', '--output-format', 'json', '--tools', '', '--setting-sources', '', '--no-session-persistence',
    '--system-prompt', system, '--json-schema', JSON.stringify(schema)];
  if (known(model)) args.push('--model', model);
  const t0 = Date.now();
  const r = await run(bin, args, {input: user, cwd, timeout: 30 * 60 * 1000});
  const res = lastJson(r.out);
  if (!res) throw new Error(firstLine(r.err) || (r.signal ? 'Claude Code took more than 30 minutes, so it was stopped.' : 'Claude Code stopped without an answer.'));
  if (res.is_error || !res.structured_output) throw new Error(firstLine(res.result) || 'Claude Code gave no suggestions.');
  // The model that did the work: the one that wrote the most.
  const used = Object.entries(res.modelUsage || {}).sort((a, b) => (b[1]?.outputTokens || 0) - (a[1]?.outputTokens || 0))[0]?.[0];
  return {output: res.structured_output, meta: {via: 'claude-code', model: used || model || '', ms: res.duration_ms ?? Date.now() - t0}};
}

// ---- the person's API key

function apiError(e) {
  const sdk = require('@anthropic-ai/sdk');
  if (e instanceof sdk.AuthenticationError) return 'Anthropic didn’t accept the API key. Check it in Settings.';
  if (e instanceof sdk.PermissionDeniedError) return 'This API key isn’t allowed to use that model.';
  if (e instanceof sdk.RateLimitError) return 'The API key reached its rate limit. Try again in a minute.';
  if (e instanceof sdk.APIConnectionError) return 'Couldn’t reach Anthropic. Check the internet connection.';
  if (e instanceof sdk.APIError) return `Anthropic said: ${e.error?.error?.message || e.message}`;
  return String(e?.message || e);
}

// The key goes only to Anthropic: the address is fixed, so nothing in the environment can send it elsewhere.
function client(key) {
  const {Anthropic} = require('@anthropic-ai/sdk');
  return new Anthropic({apiKey: key, authToken: null, baseURL: 'https://api.anthropic.com', maxRetries: 2, timeout: 30 * 60 * 1000});
}

async function askApi({system, user, schema}, {key, model, anthropic = client(key)}) {
  const id = known(model) ? model : API_DEFAULT;
  const params = {model: id, max_tokens: 128000, system, messages: [{role: 'user', content: user}],
    output_config: {effort: 'high', format: {type: 'json_schema', schema}}};
  const t0 = Date.now();
  let msg;
  try {
    // A request a safety check declines is tried again on the model Anthropic recommends for it. Haiku has no
    // such fallback.
    const stream = id === 'claude-haiku-5-5' ? anthropic.messages.stream(params)
      : anthropic.beta.messages.stream({...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'});
    msg = await stream.finalMessage();
  } catch (e) { throw new Error(apiError(e)); }
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to review this transcript.');
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude’s answer ran past its length limit before it finished.');
  // After a fallback, only what the last model wrote is the answer.
  const from = msg.content.map(b => b.type).lastIndexOf('fallback') + 1;
  const text = msg.content.slice(from).filter(b => b.type === 'text').map(b => b.text).join('');
  let output;
  try { output = JSON.parse(text); } catch { throw new Error('Claude answered in a form the app couldn’t read.'); }
  return {output, meta: {via: 'api-key', model: msg.model || id, ms: Date.now() - t0,
    tokens: {input: msg.usage?.input_tokens ?? null, output: msg.usage?.output_tokens ?? null}}};
}

// ---- the service the rest of the app uses

// settings: settings.js. safeStorage: Electron's, which keeps the key encrypted with a secret in the Keychain.
// open: opens a file the way the Finder would (shell.openPath).
function create({userData, settings, safeStorage, open}) {
  const keyFile = path.join(userData, 'anthropic-key');
  const workDir = path.join(userData, 'claude');

  const keys = {
    saved: () => fs.existsSync(keyFile),
    read() { try { return safeStorage.decryptString(fs.readFileSync(keyFile)); } catch { return ''; } },
    write(key) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('The Keychain isn’t available, so the key can’t be kept safely.');
      fs.mkdirSync(userData, {recursive: true});
      const tmp = `${keyFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, safeStorage.encryptString(key), {mode: 0o600});
      fs.renameSync(tmp, keyFile);
    },
  };
  const hint = () => { const k = keys.read(); return k ? `…${k.slice(-4)}` : ''; };
  const mode = () => settings.get().ai;

  async function status() {
    const s = settings.get();
    return {mode: s.ai, model: s.aiModel, models: MODELS, apiDefault: API_DEFAULT,
      claudeCode: s.ai === 'claude-code' ? await claudeCodeStatus() : null,
      key: {saved: keys.saved(), hint: keys.saved() ? hint() : ''}};
  }

  // Ask Claude about one transcript, the way Settings says.
  async function ask(prompt) {
    const s = settings.get();
    if (s.ai === 'claude-code') {
      fs.mkdirSync(workDir, {recursive: true});
      return askClaudeCode(prompt, {model: s.aiModel, cwd: workDir});
    }
    if (s.ai === 'api-key') {
      const key = keys.read();
      if (!key) throw new Error('There’s no API key saved. Add one in Settings.');
      return askApi(prompt, {key, model: s.aiModel});
    }
    throw new Error('Claude’s suggestions are off in Settings.');
  }

  // A key is checked with Anthropic before it is kept, so a typo shows straight away.
  async function saveKey(key) {
    const k = String(key || '').trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return {ok: false, error: 'That doesn’t look like an Anthropic API key. They start with sk-ant-.'};
    try { await client(k).models.retrieve(known(settings.get().aiModel) ? settings.get().aiModel : API_DEFAULT); } catch (e) {
      return {ok: false, error: apiError(e)};
    }
    try { keys.write(k); } catch (e) { return {ok: false, error: e.message}; }
    return {ok: true};
  }

  function forgetKey() { fs.rmSync(keyFile, {force: true}); return {ok: true}; }

  // Claude Code in a Terminal window: Anthropic's installer first if it is missing, then its own sign-in. A
  // .command file opens in Terminal without the app asking to control it, and the person sees every step.
  async function signIn() {
    const file = path.join(userData, 'Sign in to Claude Code.command');
    fs.mkdirSync(userData, {recursive: true});
    fs.writeFileSync(file, [
      '#!/bin/zsh',
      'clear',
      'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
      'echo "Transcriber: signing in to Claude Code"',
      'echo',
      'if ! command -v claude >/dev/null; then',
      '  echo "Installing Claude Code with Anthropic\'s installer:"',
      '  echo "  curl -fsSL https://claude.ai/install.sh | bash"',
      '  echo',
      '  curl -fsSL https://claude.ai/install.sh | bash || { echo; echo "The install didn\'t finish. Check the internet connection and try again."; exit 1; }',
      '  export PATH="$HOME/.local/bin:$PATH"',
      'fi',
      'echo',
      'claude auth login && { echo; echo "Signed in. You can close this window and go back to Transcriber."; }',
      '',
    ].join('\n'), {mode: 0o755});
    const err = await open(file);
    return {ok: !err, error: err || null};
  }

  const stop = () => { for (const c of running) c.kill('SIGTERM'); };

  return {mode, status, ask, saveKey, forgetKey, signIn, stop};
}

module.exports = {create, askApi, askClaudeCode, MODELS, API_DEFAULT};

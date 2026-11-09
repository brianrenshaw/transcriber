// Claude's suggestions, through the person's own Claude Code: the claude command they installed, run on the
// Claude account it is signed in to. The app has no Claude account of its own and never sees a password. What
// goes is text only, as src/core/prompt.js builds it.

const {spawn, execFile} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODELS = [
  {id: 'claude-opus-5-5', name: 'Claude Opus 5.5'},
  {id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5'},
  {id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5'},
];
const known = id => MODELS.some(m => m.id === id);

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

// ---- the service the rest of the app uses

// settings: settings.js. open: opens a file the way the Finder would (shell.openPath).
function create({userData, settings, open}) {
  const workDir = path.join(userData, 'claude');
  const mode = () => settings.get().ai;

  async function status() {
    const s = settings.get();
    return {mode: s.ai, model: s.aiModel, models: MODELS, claudeCode: s.ai === 'claude-code' ? await claudeCodeStatus() : null};
  }

  // Ask Claude about one transcript, if Settings has it on.
  async function ask(prompt) {
    const s = settings.get();
    if (s.ai !== 'claude-code') throw new Error('Claude’s suggestions are off in Settings.');
    fs.mkdirSync(workDir, {recursive: true});
    return askClaudeCode(prompt, {model: s.aiModel, cwd: workDir});
  }

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

  return {mode, status, ask, signIn, stop};
}

module.exports = {create, askClaudeCode, MODELS};

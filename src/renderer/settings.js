// The Settings window. For now it holds one thing: whether Claude suggests readings, and through which of the
// person's own Claude accounts. Everything it changes goes through the main process.

const desk = window.desk;
const $ = s => document.querySelector(s);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const ui = {status: null, busy: '', error: '', keyError: ''};

const MODES = [['off', 'Off'], ['claude-code', 'Claude Code'], ['api-key', 'API key']];
const PLAN = {max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise'};

async function load() {
  ui.status = await desk.aiStatus();
  render();
}

async function setMode(ai) {
  ui.error = ''; ui.keyError = '';
  ui.status = {...ui.status, mode: ai, claudeCode: null};
  render();
  ui.status = await desk.aiSet({ai});
  render();
}

async function setModel(aiModel) {
  ui.status = await desk.aiSet({aiModel});
  render();
}

function render() {
  const s = ui.status;
  if (!s) return;
  const pane = $('#pane');
  pane.replaceChildren(
    h('h1', {}, 'Claude’s suggestions'),
    h('p', {class: 'lede'}, 'Claude can suggest the right reading for each place the engines disagree, light punctuation, paragraphs, and who is speaking. Nothing changes in a transcript until you decide.'),
    h('div', {class: 'seg', role: 'group', 'aria-label': 'Claude’s suggestions'},
      ...MODES.map(([id, label]) => h('button', {type: 'button', 'aria-pressed': String(s.mode === id), onclick: () => s.mode !== id && setMode(id)}, label))),
    s.mode === 'claude-code' ? claudeCodePanel(s) : s.mode === 'api-key' ? keyPanel(s) : offPanel(),
    s.mode === 'off' ? null : privacy());
}

function offPanel() {
  return h('div', {class: 'panel-box'},
    h('p', {}, 'Off. Transcripts are made and checked on this Mac, and nothing is sent anywhere.'),
    h('p', {class: 'hint'}, 'Claude Code uses your own Claude plan. An API key is billed to your own Anthropic account.'));
}

// The model setting as this panel shows it: the API's default model is the same as no choice.
const chosen = s => (s.mode === 'api-key' && s.model === s.apiDefault ? '' : s.model || '');

function modelRow(s, defaultLabel) {
  const models = [{id: '', name: defaultLabel}, ...s.models.filter(m => s.mode === 'claude-code' || m.id !== s.apiDefault)];
  return h('div', {class: 'row'}, h('span', {class: 'cap'}, 'Model'),
    h('div', {class: 'line'}, h('select', {class: 'link-input', 'aria-label': 'Model', onchange: e => setModel(e.target.value)},
      ...models.map(m => h('option', {value: m.id, selected: chosen(s) === m.id}, m.name)))));
}

function claudeCodePanel(s) {
  const c = s.claudeCode;
  let state;
  if (!c) state = h('div', {class: 'status'}, h('span', {class: 'dot'}), h('span', {}, 'Checking Claude Code…'));
  else if (!c.installed) {
    state = h('div', {class: 'line'}, h('div', {class: 'status bad'}, h('span', {class: 'dot'}), h('span', {}, 'Claude Code isn’t installed on this Mac.')),
      h('button', {class: 'btn', type: 'button', onclick: signIn}, 'Install and sign in…'));
  } else if (!c.signedIn) {
    state = h('div', {class: 'line'}, h('div', {class: 'status bad'}, h('span', {class: 'dot'}), h('span', {}, c.error || 'Claude Code isn’t signed in.')),
      h('button', {class: 'btn', type: 'button', onclick: signIn}, 'Sign in…'));
  } else {
    const who = [c.email, PLAN[c.plan] || (c.method === 'claude.ai' ? 'Claude account' : c.method ? 'API key' : '')].filter(Boolean).join(' · ');
    state = h('div', {class: 'status good'}, h('span', {class: 'dot'}), h('span', {}, `Signed in${who ? ` as ${who}` : ''}`));
  }
  return h('div', {class: 'panel-box'},
    h('p', {}, 'Uses the Claude Code you have on this Mac, signed in to your own Claude account. It counts toward your plan’s usage.'),
    h('div', {class: 'row'}, h('span', {class: 'cap'}, 'Account'), state),
    ui.busy === 'signin' ? h('p', {class: 'hint'}, 'Finish signing in in the Terminal window, then come back here.') : null,
    ui.error ? h('p', {class: 'err'}, ui.error) : null,
    modelRow(s, 'Claude Code’s default'));
}

function keyPanel(s) {
  const saved = s.key.saved;
  const input = h('input', {class: 'link-input', id: 'key', type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Anthropic API key', disabled: ui.busy === 'key', onkeydown: e => { if (e.key === 'Enter') saveKey(); }});
  const keyLine = saved
    ? h('div', {class: 'line'}, h('div', {class: 'status good'}, h('span', {class: 'dot'}), h('span', {}, `Saved in your keychain ${s.key.hint}`)),
      h('button', {class: 'btn quiet', type: 'button', onclick: forgetKey}, 'Forget key'))
    : h('div', {class: 'line'}, input,
      h('button', {class: 'btn primary', type: 'button', disabled: ui.busy === 'key', onclick: saveKey}, ui.busy === 'key' ? 'Checking…' : 'Save key'));
  return h('div', {class: 'panel-box'},
    h('p', {}, 'Uses your own Anthropic API key. Anthropic bills your account for each transcript: an hour of recording is usually under $1 with Claude Opus 5.5, and less with Sonnet or Haiku.'),
    h('div', {class: 'row'}, h('span', {class: 'cap'}, 'Key'), keyLine),
    ui.keyError ? h('p', {class: 'err'}, ui.keyError) : null,
    saved ? null : h('p', {class: 'hint'}, 'The key is checked with Anthropic, then kept encrypted with your Mac’s keychain. ',
      h('button', {class: 'link', type: 'button', onclick: () => desk.aiKeyPage()}, 'Get a key')),
    modelRow(s, s.models.find(m => m.id === s.apiDefault)?.name || 'Default'));
}

function privacy() {
  return h('div', {class: 'privacy'},
    h('p', {}, 'When this is on, each new transcript’s text goes to Anthropic once the two engines finish: the words, the places they disagree, your word list and the names you typed. The audio never leaves this Mac.'),
    h('p', {}, 'For a transcript you already have, choose Ask Claude from its ··· menu.'));
}

async function signIn() {
  ui.error = '';
  const r = await desk.aiSignIn();
  if (!r.ok) ui.error = r.error || 'Terminal didn’t open.';
  else ui.busy = 'signin';
  render();
}

async function saveKey() {
  const key = $('#key')?.value || '';
  if (!key.trim()) return;
  ui.busy = 'key'; ui.keyError = '';
  render();
  const r = await desk.aiSaveKey(key);
  ui.busy = '';
  if (!r.ok) ui.keyError = r.error;
  ui.status = r.status;
  render();
  if (!r.ok) $('#key')?.focus();
}

async function forgetKey() {
  ui.keyError = '';
  ui.status = await desk.aiForgetKey();
  render();
  $('#key')?.focus();
}

// Coming back from Terminal: look again, so a new sign-in shows without a click.
window.addEventListener('focus', () => {
  if (ui.status?.mode === 'claude-code') { if (ui.busy === 'signin') ui.busy = ''; load(); }
});
desk.onAi(() => load());
load();

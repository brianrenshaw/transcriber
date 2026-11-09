// The Settings window. For now it holds one thing: whether Claude suggests readings, through the person's own
// Claude Code sign-in. Everything it changes goes through the main process.

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

const ui = {status: null, busy: '', error: ''};

const MODES = [['off', 'Off'], ['claude-code', 'Claude Code']];
const PLAN = {max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise'};

async function load() {
  ui.status = await desk.aiStatus();
  render();
}

async function setMode(ai) {
  ui.error = '';
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
    s.mode === 'claude-code' ? claudeCodePanel(s) : offPanel(),
    s.mode === 'off' ? null : privacy());
}

function offPanel() {
  return h('div', {class: 'panel-box'},
    h('p', {}, 'Off. Transcripts are made and checked on this Mac, and nothing is sent anywhere.'),
    h('p', {class: 'hint'}, 'Claude Code uses your own Claude account and counts toward your plan’s usage.'));
}

function modelRow(s) {
  const models = [{id: '', name: 'Claude Code’s default'}, ...s.models];
  return h('div', {class: 'row'}, h('span', {class: 'cap'}, 'Model'),
    h('div', {class: 'line'}, h('select', {class: 'link-input', 'aria-label': 'Model', onchange: e => setModel(e.target.value)},
      ...models.map(m => h('option', {value: m.id, selected: (s.model || '') === m.id}, m.name)))));
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
    const who = [c.email, PLAN[c.plan] || (c.method === 'claude.ai' ? 'Claude account' : '')].filter(Boolean).join(' · ');
    state = h('div', {class: 'status good'}, h('span', {class: 'dot'}), h('span', {}, `Signed in${who ? ` as ${who}` : ''}`));
  }
  return h('div', {class: 'panel-box'},
    h('p', {}, 'Uses the Claude Code you have on this Mac, signed in to your own Claude account. It counts toward your plan’s usage.'),
    h('div', {class: 'row'}, h('span', {class: 'cap'}, 'Account'), state),
    ui.busy === 'signin' ? h('p', {class: 'hint'}, 'Finish signing in in the Terminal window, then come back here.') : null,
    ui.error ? h('p', {class: 'err'}, ui.error) : null,
    modelRow(s));
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

// Coming back from Terminal: look again, so a new sign-in shows without a click.
window.addEventListener('focus', () => {
  if (ui.status?.mode === 'claude-code') { if (ui.busy === 'signin') ui.busy = ''; load(); }
});
desk.onAi(() => load());
load();

// The Electron main process: the window, the menu, the app:// protocol that serves the interface and the
// recordings, and the handlers the window calls through preload.js.

const {app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, protocol, screen, shell} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {Readable} = require('node:stream');
const Settings = require('./settings');
const Store = require('./store');
const Pipeline = require('./pipeline');
const Speech = require('./speech');
const {items, paragraphStarts, assemble, progress, emptyReview} = require('../core/review');

app.setName('Transcriber');
// TRANSCRIBER_HOME keeps a test run's settings, models and transcripts apart from the real ones.
if (process.env.TRANSCRIBER_HOME) app.setPath('userData', path.resolve(process.env.TRANSCRIBER_HOME));
const UI = path.join(__dirname, '..', 'renderer');
const snapshotDir = (process.argv.find(a => a.startsWith('--snapshot=')) || '').split('=')[1];
// One copy at a time per data folder: a second launch just brings the first one forward, so two pipelines
// never work on the same transcripts.
const primary = Boolean(snapshotDir) || app.requestSingleInstanceLock();
if (!primary) app.quit();

protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true}}]);

const userData = app.getPath('userData');
const settings = Settings.create(userData);
const store = Store.create(() => settings.dataDir());
// The person's word list. It has no editor yet; a word-list.json in userData is read when it is there.
const words = () => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'word-list.json'), 'utf8')); } catch { return []; } };
let win = null;
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const emit = job => send('job', summary(job));
// The speech engines inside the app, and the one-time download of their models.
const speech = Speech.create({userData, onState: s => send('speech', s)});
const pipeline = Pipeline.create({store, speech, words, emit});

const TYPES = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime'};

// A file under base, or null if the path would leave it.
function within(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + decodeURIComponent(rel)));
  return p.startsWith(path.resolve(base) + path.sep) ? p : null;
}

function serveFile(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', {status: 404});
  return new Response(fs.readFileSync(file), {headers: {'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'}});
}

// Audio with byte ranges, so the player can seek.
function serveMedia(file, req) {
  if (!file || !fs.existsSync(file)) return new Response('Not found', {status: 404});
  const size = fs.statSync(file).size, type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m) {
    return new Response(Readable.toWeb(fs.createReadStream(file)), {headers: {'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes'}});
  }
  const start = m[1] ? +m[1] : Math.max(0, size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
  if (start >= size || end < start) return new Response(null, {status: 416, headers: {'content-range': `bytes */${size}`}});
  return new Response(Readable.toWeb(fs.createReadStream(file, {start, end})), {status: 206, headers: {
    'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes'}});
}

async function handle(req) {
  const u = new URL(req.url);
  if (u.host !== 'ui') return new Response('Not found', {status: 404});
  // One origin for everything: /media/<id> is a recording, the rest the interface.
  const [, first, second = ''] = u.pathname.split('/');
  if (first === 'media') {
    const job = /^[A-Za-z0-9-]+$/.test(second) && store.get(second);
    return serveMedia(job ? store.file(second, job.audio) : null, req);
  }
  return serveFile(within(UI, u.pathname));
}

// What the list needs about a transcript. The work files are large, so the counts are kept until one changes.
const counted = new Map();
function summary(job) {
  const out = {id: job.id, title: job.title, createdAt: job.createdAt, steps: job.steps, people: job.speakers || [], file: job.file || ''};
  const stamp = ['work.json', 'ai.json', 'review.json'].map(f => store.file(job.id, f))
    .map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join();
  const hit = counted.get(job.id);
  if (hit && hit.stamp === stamp) return {...out, ...hit.counts};
  const w = pipeline.work(job.id);
  const counts = {};
  if (w) {
    counts.progress = progress(w, store.readJson(job.id, 'review.json', emptyReview()));
    const last = w.transcript.words[w.transcript.words.length - 1];
    counts.seconds = last ? last.e : 0;
  }
  counted.set(job.id, {stamp, counts});
  return {...out, ...counts};
}

// Everything the review screen needs for one transcript.
function openJob(id) {
  const job = store.get(id);
  if (!job) return null;
  const w = pipeline.work(id);
  const review = store.readJson(id, 'review.json', emptyReview());
  return {
    job: summary(job),
    words: w ? w.transcript.words : [],
    segments: w ? w.transcript.segments : [],
    items: w ? items(w, review) : [],
    paragraphs: w ? [...paragraphStarts(w, review)].sort((a, b) => a - b) : [],
    speakers: w ? w.transcript.speakers || [] : [],
    aiSpeakers: w?.claude?.speakers || [],
    speakerFixes: w?.claude?.speakerFixes || [],
    stats: w ? w.stats : null,
    review,
  };
}

const fileSafe = s => String(s || '').replace(/[/:\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Transcript';

async function exportJob(id) {
  const job = store.get(id), w = pipeline.work(id);
  if (!job || !w) return null;
  const {canceled, filePath} = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `${fileSafe(job.title)}.txt`),
    filters: [{name: 'Plain text', extensions: ['txt']}, {name: 'Markdown', extensions: ['md']}],
  });
  if (canceled || !filePath) return null;
  writeExport(w, store.readJson(id, 'review.json', emptyReview()), filePath);
  return filePath;
}

// The transcript as it reads now: every decision applied, suggestions nobody decided left out.
function writeExport(w, review, filePath) {
  const blocks = assemble(w, review);
  const md = path.extname(filePath).toLowerCase() === '.md';
  const text = blocks.map(b => (b.type === 'heading' ? (md ? `## ${b.text}` : b.text)
    : b.type === 'speaker' ? (md ? `**${b.text}:**` : `${b.text}:`) : b.text)).join('\n\n') + '\n';
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, filePath);
}

function ipc() {
  const on = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));
  on('jobs', () => store.list().map(summary));
  on('open', id => openJob(id));
  on('add', async (paths, speakers) => {
    const added = [], errors = [];
    for (const p of paths) {
      try { const job = store.add(p, {speakers}); added.push(job.id); emit(job); pipeline.enqueue(job.id); } catch (e) { errors.push(e.message); }
    }
    return {added, errors};
  });
  on('choose', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog(win, {properties: ['openFile', 'multiSelections'],
      filters: [{name: 'Recordings', extensions: [...Store.AUDIO].map(e => e.slice(1))}]});
    return canceled ? [] : filePaths;
  });
  on('review', (id, review) => {
    store.writeJson(id, 'review.json', review);
    const job = store.get(id);
    if (job) emit(job);
    return true;
  });
  // A right-click in the transcript: a native menu of [{id, label}], resolving with the id chosen, or null.
  on('wordMenu', list => new Promise(resolve => {
    const m = Menu.buildFromTemplate((list || []).map(it => ({label: String(it.label), click: () => resolve(it.id)})));
    m.popup({window: win, callback: () => setTimeout(() => resolve(null), 100)});
  }));
  on('rerun', (id, step) => { pipeline.rerun(id, step); return true; });
  on('export', id => exportJob(id));
  on('trash', async id => { await shell.trashItem(store.dir(id)); return true; });
  on('reveal', id => { shell.showItemInFolder(store.file(id, 'job.json')); return true; });
  on('speech', () => speech.status());
  on('speechPrepare', () => { speech.prepare().catch(() => {}); return speech.state(); });
}

function menu() {
  const tell = what => () => send('menu', what);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {role: 'appMenu', submenu: [{role: 'about'}, {type: 'separator'}, {role: 'hide'}, {role: 'hideOthers'}, {role: 'unhide'},
      {type: 'separator'}, {role: 'quit'}]},
    {label: 'File', submenu: [{label: 'Add Recording…', accelerator: 'Cmd+O', click: tell('add')},
      {label: 'Export Transcript…', accelerator: 'Cmd+E', click: tell('export')}, {type: 'separator'}, {role: 'close'}]},
    {role: 'editMenu'},
    {label: 'View', submenu: [{role: 'reload'}, {role: 'toggleDevTools'}, {type: 'separator'}, {role: 'togglefullscreen'}]},
    {role: 'windowMenu'},
  ]));
}

function createWindow() {
  // Never open wider or taller than the screen it lands on.
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: snapshotDir ? 1280 : Math.min(1280, area.width - 40), height: snapshotDir ? 820 : Math.min(820, area.height - 40),
    minWidth: Math.min(900, area.width - 40), minHeight: 560, center: true, show: !snapshotDir,
    titleBarStyle: 'hiddenInset', trafficLightPosition: {x: 16, y: 18},
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1E1E1E' : '#FFFFFF',
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false},
  });
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadURL('app://ui/index.html');
  if (snapshotDir) {
    // A screenshot run reports the window's warnings and errors, so a broken screen shows in the output too.
    win.webContents.on('console-message', e => { if (e.level === 'warning' || e.level === 'error') console.log(`[window ${e.level}] ${e.message}`); });
    win.webContents.once('did-finish-load', () => snapshots(win, snapshotDir));
  }
}

// Screenshots of the main states, for checking the interface without clicking through it. SNAPSHOT_JOB picks
// the transcript to photograph; otherwise the newest.
async function snapshots(w, dir) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  const js = code => w.webContents.executeJavaScript(code);
  try {
    await wait(1500);
    if (process.env.SNAPSHOT_JOB) { await js(`window.__test.open(${JSON.stringify(process.env.SNAPSHOT_JOB)})`); await wait(900); }
    // The transcript on screen now (SNAPSHOT_JOB, or the newest the window opened), so each theme starts on it.
    const id = await js('window.__test && window.__test.current()');
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      await wait(400);
      await shot(`${theme}-1-review`);
      // Two decisions: Whisper's reading for the first flag, Parakeet's for the second.
      if (theme === 'light') for (const k of [2, 1]) { await js(`window.__test && window.__test.key(${k})`); await wait(400); }
      await shot(`${theme}-2-after-decisions`);
      await js('window.__test && window.__test.tab("changes")'); await wait(400); await shot(`${theme}-3-changes`);
      await js('window.__test && window.__test.tab("transcript")'); await wait(300);
      await js('window.__test && window.__test.home()'); await wait(500); await shot(`${theme}-4-home`);
      if (id) { await js(`window.__test.open(${JSON.stringify(id)})`); await wait(700); }
    }
  } finally { app.quit(); }
}

app.on('second-instance', () => showWindow());

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.whenReady().then(() => {
  if (!primary) return;
  protocol.handle('app', handle);
  ipc();
  menu();
  createWindow();
  // A screenshot run only looks; it never starts work another process may be doing.
  if (!snapshotDir) {
    // On a new Mac the models download straight away, so the first recording does not wait for them.
    speech.status().then(s => { if (s.state === 'missing') speech.prepare().catch(() => {}); });
    pipeline.resume();
  }
});
// Closing the window leaves the app running, so work in progress carries on; the Dock icon brings the window
// back, and Quit (⌘Q) ends it.
app.on('window-all-closed', () => { if (snapshotDir) app.quit(); });
app.on('activate', () => { if (primary && app.isReady()) showWindow(); });

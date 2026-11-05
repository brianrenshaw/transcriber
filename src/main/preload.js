// The only bridge between the window and the main process.
const {contextBridge, ipcRenderer, webUtils} = require('electron');

const call = (name, ...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('desk', {
  jobs: () => call('jobs'),
  open: id => call('open', id),
  add: (paths, speakers) => call('add', paths, speakers),
  choose: () => call('choose'),
  saveReview: (id, review) => call('review', id, review),
  wordMenu: list => call('wordMenu', list),
  rerun: (id, step) => call('rerun', id, step),
  exportJob: id => call('export', id),
  trash: id => call('trash', id),
  reveal: id => call('reveal', id),
  speech: () => call('speech'),
  speechPrepare: () => call('speechPrepare'),
  onSpeech: fn => ipcRenderer.on('speech', (_e, s) => fn(s)),
  pathFor: file => webUtils.getPathForFile(file),
  onJob: fn => ipcRenderer.on('job', (_e, job) => fn(job)),
  onMenu: fn => ipcRenderer.on('menu', (_e, what) => fn(what)),
});

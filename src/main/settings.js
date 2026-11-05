// Settings belong to the machine, not the repository, so each computer keeps its own. They are stored in the
// app's userData folder as settings.json.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  dataDir: '',             // where transcripts live; empty: <userData>/Transcripts
};

function create(userData) {
  const file = path.join(userData, 'settings.json');
  let current = {...DEFAULTS};
  try { current = {...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8'))}; } catch {}
  return {
    get: () => ({...current}),
    dataDir: () => current.dataDir || path.join(userData, 'Transcripts'),
    set(patch) {
      current = {...current, ...Object.fromEntries(Object.entries(patch).filter(([k]) => k in DEFAULTS).map(([k, v]) => [k, String(v ?? '').trim()]))};
      fs.mkdirSync(userData, {recursive: true});
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
      fs.renameSync(tmp, file);
      return {...current};
    },
    defaults: () => ({...DEFAULTS}),
  };
}

module.exports = {create, DEFAULTS};

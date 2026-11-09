// Settings belong to the machine, not the repository, so each computer keeps its own. They are stored in the
// app's userData folder as settings.json.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  dataDir: '',             // where transcripts live; empty: <userData>/Transcripts
  ai: 'off',               // Claude's suggestions: off, or claude-code (the person's own Claude Code sign-in)
  aiModel: '',             // empty: Claude Code's own default model
  skippedVersion: '',      // a newer version the person dismissed, so its line stays away
};
// The values a setting may take, where it has a fixed set; anything else keeps the setting as it was.
const CHOICES = {ai: ['off', 'claude-code']};

function create(userData) {
  const file = path.join(userData, 'settings.json');
  let current = {...DEFAULTS};
  try { current = {...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8'))}; } catch {}
  // A value the app no longer offers goes back to the default.
  for (const [k, ok] of Object.entries(CHOICES)) if (!ok.includes(current[k])) current[k] = DEFAULTS[k];
  return {
    get: () => ({...current}),
    dataDir: () => current.dataDir || path.join(userData, 'Transcripts'),
    set(patch) {
      const clean = Object.entries(patch).filter(([k]) => k in DEFAULTS).map(([k, v]) => [k, String(v ?? '').trim()])
        .filter(([k, v]) => !CHOICES[k] || CHOICES[k].includes(v));
      current = {...current, ...Object.fromEntries(clean)};
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

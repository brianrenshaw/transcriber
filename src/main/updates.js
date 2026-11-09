// Whether a newer Transcriber is out. When the app starts, and once a day while it runs, it asks GitHub for this
// repository's latest release. Nothing goes with the question but the app's name and version, and the app never
// downloads or installs a new version itself: the window shows a line, and Download opens the release's page in
// the browser.

const REPO = 'brianrenshaw/transcriber';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const PAGE = `https://github.com/${REPO}/releases/tag/`;
const DAY = 24 * 60 * 60 * 1000;

// "v0.2.0" or "0.2.0" as [0, 2, 0]; anything else, a pre-release included, as null.
const parse = v => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim()); return m ? m.slice(1).map(Number) : null; };
function newer(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && x[i] > y[i];
}

// The release GitHub calls latest, when it is newer than `current`: {version, url}. Null otherwise.
async function latest({current, fetch}) {
  const res = await fetch(LATEST, {headers: {accept: 'application/vnd.github+json', 'user-agent': `Transcriber/${current}`}});
  if (!res.ok) return null;
  const r = await res.json();
  if (!r || r.draft || r.prerelease || !parse(r.tag_name) || !newer(r.tag_name, current)) return null;
  // The page is built from the tag, so the app only ever opens a release of this repository.
  return {version: parse(r.tag_name).join('.'), url: PAGE + encodeURIComponent(String(r.tag_name).trim())};
}

// settings: settings.js, where a dismissed version is kept. open: opens a page in the browser.
// onChange: gets the release to show, or null.
function create({current, settings, fetch, open, onChange = () => {}}) {
  let found = null, timer = null;
  // A version the person dismissed stays dismissed; the next one shows.
  const shown = () => (found && settings.get().skippedVersion !== found.version ? {...found} : null);

  async function check() {
    try { found = await latest({current, fetch}); }
    catch { return; }   // offline, or GitHub not answering: nothing to say
    onChange(shown());
  }

  return {
    check,
    state: shown,
    start() {
      check();
      timer = setInterval(check, DAY);
      timer.unref?.();
    },
    stop() { clearInterval(timer); },
    open() { if (found) open(found.url); },
    skip() {
      if (found) settings.set({skippedVersion: found.version});
      onChange(shown());
    },
  };
}

module.exports = {create, latest, newer, LATEST};

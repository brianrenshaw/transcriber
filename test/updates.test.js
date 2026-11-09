// The new-version check: GitHub's latest release, shown only when it is newer, opened only as a page of this
// repository, and kept away once dismissed. A fake fetch stands in for GitHub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Updates = require('../src/main/updates');
const Settings = require('../src/main/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-updates-'));
const PAGE = 'https://github.com/brianrenshaw/transcriber/releases/tag/';

// Answers the latest-release request with `release`, or with `status`; `asked` keeps each request.
function fakeGitHub(release, {status = 200} = {}) {
  const asked = [];
  const fetch = async (url, opts) => {
    asked.push({url, opts});
    if (url !== Updates.LATEST) return new Response('not found', {status: 404});
    return new Response(JSON.stringify(release), {status, headers: {'content-type': 'application/json'}});
  };
  return {fetch, asked};
}

test('versions compare as numbers, and anything else is never newer', () => {
  assert.equal(Updates.newer('0.2.0', '0.1.1'), true);
  assert.equal(Updates.newer('v0.10.0', '0.9.9'), true);
  assert.equal(Updates.newer('1.0.0', '0.99.99'), true);
  assert.equal(Updates.newer('0.1.1', '0.1.1'), false);
  assert.equal(Updates.newer('v0.1.0', '0.1.1'), false);
  assert.equal(Updates.newer('0.2.0-beta.1', '0.1.1'), false);
  assert.equal(Updates.newer('latest', '0.1.1'), false);
  assert.equal(Updates.newer(undefined, '0.1.1'), false);
});

test('a newer release is found, and its page comes from the tag, not from the answer', async () => {
  const gh = fakeGitHub({tag_name: 'v0.2.0', html_url: 'https://example.com/elsewhere', draft: false, prerelease: false});
  const found = await Updates.latest({current: '0.1.1', fetch: gh.fetch});
  assert.deepEqual(found, {version: '0.2.0', url: `${PAGE}v0.2.0`});
  // The question carries the app's name and version and nothing else.
  assert.equal(gh.asked.length, 1);
  assert.deepEqual(gh.asked[0].opts.headers, {accept: 'application/vnd.github+json', 'user-agent': 'Transcriber/0.1.1'});
});

test('the same or an older version, a pre-release, a draft, an odd tag or an error finds nothing', async () => {
  const none = async (release, opts) => Updates.latest({current: '0.1.1', fetch: fakeGitHub(release, opts).fetch});
  assert.equal(await none({tag_name: 'v0.1.1'}), null);
  assert.equal(await none({tag_name: 'v0.1.0'}), null);
  assert.equal(await none({tag_name: 'v0.2.0', prerelease: true}), null);
  assert.equal(await none({tag_name: 'v0.2.0', draft: true}), null);
  assert.equal(await none({tag_name: 'v0.2.0/../../x'}), null);
  assert.equal(await none({message: 'Not Found'}, {status: 404}), null);
  assert.equal(await none({message: 'API rate limit exceeded'}, {status: 403}), null);
});

test('the line shows a newer version, opens its page, and stays away once dismissed', async () => {
  const dir = tmp();
  const settings = Settings.create(dir);
  const opened = [], changes = [];
  const updates = Updates.create({current: '0.1.1', settings, fetch: fakeGitHub({tag_name: 'v0.2.0'}).fetch,
    open: url => opened.push(url), onChange: u => changes.push(u)});
  assert.equal(updates.state(), null);
  updates.open();
  assert.deepEqual(opened, []);

  await updates.check();
  assert.deepEqual(updates.state(), {version: '0.2.0', url: `${PAGE}v0.2.0`});
  assert.deepEqual(changes, [{version: '0.2.0', url: `${PAGE}v0.2.0`}]);
  updates.open();
  assert.deepEqual(opened, [`${PAGE}v0.2.0`]);

  updates.skip();
  assert.equal(updates.state(), null);
  assert.equal(changes.at(-1), null);
  // Dismissed on this Mac, so a later launch does not show it either.
  assert.equal(Settings.create(dir).get().skippedVersion, '0.2.0');
  const again = Updates.create({current: '0.1.1', settings: Settings.create(dir), fetch: fakeGitHub({tag_name: 'v0.2.0'}).fetch, open() {}});
  await again.check();
  assert.equal(again.state(), null);

  // The next version shows.
  const next = Updates.create({current: '0.1.1', settings: Settings.create(dir), fetch: fakeGitHub({tag_name: 'v0.3.0'}).fetch, open() {}});
  await next.check();
  assert.equal(next.state().version, '0.3.0');
});

test('offline, the check says nothing and keeps what it knew', async () => {
  const settings = Settings.create(tmp());
  let online = true;
  const gh = fakeGitHub({tag_name: 'v0.2.0'});
  const changes = [];
  const updates = Updates.create({current: '0.1.1', settings, open() {}, onChange: u => changes.push(u),
    fetch: async (url, opts) => { if (!online) throw new TypeError('fetch failed'); return gh.fetch(url, opts); }});
  await updates.check();
  online = false;
  await updates.check();
  assert.equal(changes.length, 1);
  assert.equal(updates.state().version, '0.2.0');
});

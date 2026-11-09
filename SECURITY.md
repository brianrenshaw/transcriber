# Security

## Reporting a problem

Report it privately with **Report a vulnerability** on this repository's Security tab, not in a public issue.
Say what you found, how to make it happen, and which version of Transcriber you were running.

## What the app does

Recordings and transcripts stay on your Mac. The only thing the app downloads is the speech models. The only
thing it sends anywhere is a transcript's text, to Anthropic, and only when you turn on Claude's suggestions.

**The models.** Every model file comes from one fixed commit of its Hugging Face repo, listed with its size and
SHA-256 in `src/main/models.json`. The app downloads each file itself, hashes it as it arrives, and keeps it only
if it matches; a file that does not match is deleted, and the download stops. The speech helper only loads files
the app has checked: it never downloads anything, and FluidAudio's own downloader inside it points at an address
that cannot resolve, so a missing file fails the job instead of being fetched unchecked. `scripts/models.js`
writes the list, and checks each small file against the git id its commit names.

**Claude's suggestions.** They are off until you choose Claude Code in Settings. Then, after the
two engines finish, the app sends Claude the transcript's text, the places the engines disagree, your word list
and the names you typed when adding the recording. It never sends the audio. Claude's answer is held as
suggestions in `ai.json`, and none of them goes into the text until you accept it.

The app runs the `claude` command already installed on your Mac, signed in to your own account. It removes the
variables that would point Claude Code at an API key or a cloud provider, and runs it with no tools, no settings
files and no saved session, in an empty folder of its own. The app never sees your Claude password: the Sign in
button opens Terminal on a script you can read, which runs Anthropic's installer if Claude Code is missing and
then `claude auth login`.

**The window.** The page runs sandboxed, with context isolation and no Node. Its content security policy allows
only the app's own files. It cannot navigate away or open new windows, and every permission it asks for
(camera, microphone, location, notifications, the clipboard) is refused.

**The built app.** The build sets Electron's fuses before signing. The app cannot be run as plain Node
(`ELECTRON_RUN_AS_NODE`), ignores `NODE_OPTIONS` and the `--inspect` flags, loads only from its `app.asar`, and
refuses to start if that file no longer matches the hash in its Info.plist. A release is signed with a
Developer ID under the hardened runtime and notarized by Apple. Electron gets one exception, for its
JavaScript engine's compiler; the speech helper gets none.

## Checking a download

A release's notes give the zip's SHA-256. After downloading:

```bash
shasum -a 256 ~/Downloads/Transcriber-*.zip
```

After moving the app to Applications:

```bash
spctl --assess --type execute --verbose /Applications/Transcriber.app
```

It should say `source=Notarized Developer ID`. A copy that was changed after signing does not open.

## How a release is built

On the maintainer's Mac, never in CI, so the signing key stays in that Mac's keychain:

1. A clean checkout of the release's tag.
2. `npm ci` and `npm test`.
3. `npm run share`, which builds the speech helper, signs, notarizes and checks the fuses. It builds the
   helper in the user's private cache folder, so no copy of the app carries the builder's name or folders.
4. The zip goes on the GitHub release, with its SHA-256 in the notes.

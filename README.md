# Transcriber

A Mac transcription app for people who need the transcript to be right. It runs two speech engines on your Mac,
flags every place they heard different words, and lets you settle those places beside the audio instead of
listening to the whole recording again.

Transcribing runs locally on Apple silicon, and nothing is uploaded. If you want a second reader, Claude can
suggest the right reading for each flagged place, using your own Claude Code sign-in. That is off until you turn
it on, and a suggestion never goes into the text until you accept it.

It is an open-source project, not a product for sale.

## What works now

Drop an audio or video file on the window (or press ⌘O). The app copies it into its own transcript folder, then:

1. **Parakeet** transcribes it and tells the voices apart.
2. **Whisper** transcribes it again as a second opinion. If Whisper fails, the transcript still opens, with no flags.
3. **The comparison** lines the two up word by word and flags each place they heard different words.
4. **Claude**, if you have turned it on in Settings (⌘,), reads the transcript and suggests a reading for each
   flag, light punctuation, paragraphs and the speakers' names. It gets the text only, never the audio.

The review screen shows the transcript beside a player. Each flag plays its moment and offers both readings,
and Claude's when it has one: press a number, type your own, or move on. Select any words to change them. The Changes tab lists every flag and
edit in groups. ⌘E exports the reviewed text as `.txt` or `.md`.

Still to come: a library with search, a word-list editor (a `word-list.json` in the app's data folder is read
if it is there), SRT, VTT and DOCX export, recording, and batch work.

## Download

Download `Transcriber-<version>.zip` from the [latest release](https://github.com/brianrenshaw/transcriber/releases/latest),
open it, and move Transcriber to Applications. It needs a Mac with Apple silicon on macOS 14 or later. The app is
signed with a Developer ID and notarized by Apple, and [SECURITY.md](SECURITY.md) shows how to check the download.
The first launch downloads the speech models, about 1.1 GB.

## Build and run

You need a Mac with Apple silicon on macOS 14 or later, Node 24, and Xcode or its command-line tools (for Swift).

```bash
npm install
```

```bash
npm run speech
```

```bash
npm start
```

The first launch downloads the speech models, about 1.1 GB, into the app's data folder
(`~/Library/Application Support/Transcriber`). Every file comes from a fixed commit on Hugging Face and is kept
only if its SHA-256 matches the list in `src/main/models.json`; a recording with a word list also downloads a
100 MB model the first time. `node scripts/models.js` moves the pins to newer models. Set
`TRANSCRIBER_HOME=<folder>` to use another data folder, which keeps test runs away from your real transcripts.

```bash
npm test
```

`npm run app` builds `Transcriber.app` and installs it in Applications. `npm run share` builds a zip signed with
your Developer ID and notarized by Apple; set `TRANSCRIBER_BUNDLE_ID` and `TRANSCRIBER_NOTARY_PROFILE` for your
own copy (see `scripts/package-app.js`). Both set Electron's fuses, so the built app cannot be run as plain Node
and refuses an `app.asar` that has been changed. [SECURITY.md](SECURITY.md) has the rest, and how to report a
problem.

`node scripts/run-pipeline.js --home <folder> <recording>...` runs the three steps without the window and prints
the words, the flags and how often the engines agreed. `npm run snapshot` renders the screens to PNGs in
`out/snapshots`.

## Claude's suggestions

Settings (⌘,) has two choices:

- **Off**, the default. Nothing leaves your Mac.
- **Claude Code** runs the `claude` command on your Mac, signed in to your own Claude account, and counts toward
  your plan. If Claude Code is missing or signed out, the Sign in button opens Terminal to install it and sign in.

New recordings get suggestions as soon as the engines finish. For one you already have, choose Ask Claude from
its ··· menu. [SECURITY.md](SECURITY.md) says exactly what is sent.

## How it is put together

| Path | What it is |
| --- | --- |
| `src/core/` | the review logic, free of Electron: `compare.js` (the two engines, word by word, using `sm.js`, a port of Python's difflib), `review.js` (flags, decisions, the reviewed text), `wordlist.js`, `text.js`, `prompt.js` (what Claude is asked, and the shape of its answer), `ai.js` (placing Claude's answer on the transcript) |
| `src/main/` | the main process: `main.js` (window, menus, the `app://` protocol, export), `store.js` (one folder per transcript), `pipeline.js` (the steps, one transcript at a time), `speech.js` (runs the helper), `settings.js`, `claude.js` (Claude's suggestions, through Claude Code), `models.js` (downloads the speech models and checks every file against `models.json`), `preload.js` (the window's only bridge) |
| `src/renderer/` | the window: plain HTML, CSS and JavaScript |
| `native/speech/` | `transcriber-speech`, the Swift helper that runs Parakeet (FluidAudio) and Whisper (WhisperKit) on Core ML. It loads the models the app downloaded and never downloads anything itself |
| `scripts/` | `package-app.js` (build the app), `models.js` (pin the speech models), `run-pipeline.js` (the steps from the command line), `notices.js` (write the third-party notices) |
| `test/` | `node --test` suites for `src/core`, Claude's suggestions, the model downloads and the design tokens |

Each transcript is a folder: `job.json`, the audio, `asr/parakeet.json`, `asr/whisper.json`, `work.json` (the
transcript and its flags), `ai.json` (Claude's suggestions, and which model made them) and `review.json` (your
decisions). The folders are the truth; anything else is a cache.

## License

MIT, see [LICENSE](LICENSE). The app is built on Electron, FluidAudio, WhisperKit and swift-argument-parser, and
it uses Parakeet (CC BY 4.0), pyannote Community-1 (CC BY 4.0) and Whisper (MIT) models, downloaded on first
launch. Their licenses and credits are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); run
`npm run notices` after changing a dependency.

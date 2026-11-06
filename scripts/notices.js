// Write THIRD_PARTY_NOTICES.md from the license files of what the app ships and uses:
//   - Electron, which the app is built on (Chromium's licenses are in LICENSES.chromium.html, which the build
//     puts inside the app beside this file),
//   - the Swift packages compiled into the speech helper, read from native/speech/Package.resolved and the
//     checkouts in native/speech/.build,
//   - the npm packages the app ships (dependencies, not devDependencies), read from package-lock.json,
//   - the speech models the app downloads on first launch (not part of this repo or the app).
//
//   npm run notices     after npm install and npm run speech, and again whenever a dependency changes

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const speech = path.join(root, 'native', 'speech');
const checkouts = path.join(speech, '.build', 'checkouts');
const out = path.join(root, 'THIRD_PARTY_NOTICES.md');

const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const fence = text => `\`\`\`\`text\n${text}\n\`\`\`\``;
const LICENSE_FILE = /^(licen[cs]e|copying|notices?)(\.(md|txt))?$/i;

function licenseFiles(dir) {
  const found = [];
  const walk = (d, deep) => {
    for (const e of fs.readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && (deep || e.name === 'ThirdPartyLicenses')) walk(p, true);
      else if (e.isFile() && (deep || LICENSE_FILE.test(e.name))) found.push(p);
    }
  };
  walk(dir, false);
  return found;
}

function section(title, lines, files, base) {
  const parts = [`## ${title}`, '', ...lines, ''];
  for (const f of files) parts.push(`### ${path.relative(base, f)}`, '', fence(read(f)), '');
  return parts.join('\n');
}

// What a package's own notices cover that the app does not ship. FluidAudio's text-to-speech data goes in a
// separate SwiftPM resource bundle (FluidAudio_LuxTtsG2pResources.bundle), and package-app.js copies only the
// helper executable, whose bytes do not contain that data.
const NOTES = {
  FluidAudio: "The app ships only the helper executable and never runs text to speech. FluidAudio's text-to-speech " +
    'data (the Kokoro and LuxTTS files described below, including the GPL-3.0 and CC-BY-SA material) is in a ' +
    'separate resource bundle that the app does not include. Its notices are reproduced here as FluidAudio publishes them.',
};

const MODELS = `## Speech models

The app downloads these models from Hugging Face on first launch, into its data folder, each from a fixed commit
and checked against the SHA-256 listed in \`src/main/models.json\`. They are not part of this repository or the
app. Each is a Core ML conversion of the original, modified for Apple silicon by the converter named, except
Whisper's tokenizer, which is used as OpenAI published it.

| Model | Used for | Original | Core ML conversion | License |
| --- | --- | --- | --- | --- |
| Parakeet TDT 0.6B v3 | transcription and word times | NVIDIA, [nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | Fluid Inference, [FluidInference/parakeet-tdt-0.6b-v3-coreml](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Parakeet TDT-CTC 110M | spotting word-list terms (downloaded only when the word list has terms to boost) | NVIDIA, [nvidia/parakeet-tdt_ctc-110m](https://huggingface.co/nvidia/parakeet-tdt_ctc-110m) | Fluid Inference, [FluidInference/parakeet-ctc-110m-coreml](https://huggingface.co/FluidInference/parakeet-ctc-110m-coreml) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| pyannote Community-1 speaker diarization (segmentation, WeSpeaker embedding, PLDA) | telling the voices apart | pyannote, WeSpeaker and BUT Speech@FIT, [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) | Fluid Inference, [FluidInference/speaker-diarization-coreml](https://huggingface.co/FluidInference/speaker-diarization-coreml) ([notice](https://huggingface.co/FluidInference/speaker-diarization-coreml/blob/main/NOTICE.md)) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Whisper large-v3 turbo (openai_whisper-large-v3-v20240930_626MB) | the second transcription the first is checked against | OpenAI, [openai/whisper](https://github.com/openai/whisper) | Argmax, [argmaxinc/whisperkit-coreml](https://huggingface.co/argmaxinc/whisperkit-coreml) | MIT |
| Whisper large-v3 tokenizer (tokenizer.json, tokenizer_config.json, config.json) | turning Whisper's tokens into words | OpenAI, [openai/whisper-large-v3](https://huggingface.co/openai/whisper-large-v3) | none, used as published | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
`;

function main() {
  if (!fs.existsSync(checkouts)) throw new Error('No Swift checkouts yet. Run npm run speech first.');
  const electronDir = path.join(root, 'node_modules', 'electron');
  const electron = require(path.join(electronDir, 'package.json')).version;
  const pins = JSON.parse(fs.readFileSync(path.join(speech, 'Package.resolved'), 'utf8')).pins;
  const dirs = fs.readdirSync(checkouts);

  const parts = [
    '# Third-party notices',
    '',
    'Transcriber is released under the MIT License (see LICENSE). It is built on the software below, and it uses',
    'the speech models listed under "Speech models". Generated by `scripts/notices.js`; do not edit by hand.',
    '',
    section(`Electron ${electron}`, ['https://github.com/electron/electron',
      '', "Chromium's and its components' licenses are in LICENSES.chromium.html, inside the app's Resources folder."],
    [path.join(electronDir, 'dist', 'LICENSE')], path.join(electronDir, 'dist')),
  ];
  for (const pin of pins) {
    const dir = dirs.find(d => d.toLowerCase() === pin.identity.toLowerCase());
    if (!dir) throw new Error(`No checkout for ${pin.identity}. Run npm run speech first.`);
    const version = pin.state.version || pin.state.revision.slice(0, 12);
    const files = licenseFiles(path.join(checkouts, dir));
    if (!files.length) throw new Error(`No license file found for ${pin.identity}.`);
    parts.push(section(`${dir} ${version}`, [pin.location.replace(/\.git$/, ''), '', 'Compiled into the speech helper.', ...(NOTES[dir] ? ['', NOTES[dir]] : [])],
      files, path.join(checkouts, dir)));
  }
  // The npm packages inside the app: package-lock.json's entries that are not only for building.
  const lock = JSON.parse(read(path.join(root, 'package-lock.json')));
  for (const [key, info] of Object.entries(lock.packages || {})) {
    if (!key || info.dev || info.devOptional) continue;
    const dir = path.join(root, key);
    if (!fs.existsSync(path.join(dir, 'package.json'))) throw new Error(`${key} is missing. Run npm ci first.`);
    const pkg = JSON.parse(read(path.join(dir, 'package.json')));
    const files = licenseFiles(dir);
    if (!files.length && !pkg.license) throw new Error(`No license found for ${pkg.name}.`);
    const repo = String(pkg.repository?.url || pkg.repository || pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`)
      .replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/');
    const bare = files.length ? [] : ['', `The package includes no license text; its package.json declares the ${pkg.license} license.`];
    parts.push(section(`${pkg.name} ${pkg.version}`, [repo, '', `npm package (${pkg.license}), shipped inside the app.`, ...bare], files, dir));
  }
  parts.push(MODELS);
  fs.writeFileSync(out, parts.join('\n'));
  console.log(`Wrote ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}

main();

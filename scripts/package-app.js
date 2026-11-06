// Build Transcriber.app from this checkout.
//
//   npm run app       build it and install it on this Mac (signed for this Mac only, ad hoc)
//   npm run share     build it signed with your Developer ID and notarized by Apple, zipped to send to someone
//
// All of them build the speech helper (native/speech, Swift) first and put it inside the app; its models
// download on the app's first launch. The app is for Apple silicon, like the helper.
//
// Signing needs a "Developer ID Application" certificate in this Mac's keychain, and notarization a saved
// notarytool login named transcriber (or the name in TRANSCRIBER_NOTARY_PROFILE):
//   xcrun notarytool store-credentials transcriber --apple-id <Apple ID> --team-id <Team ID>
// `npm run share -- --adhoc` builds an unsigned zip instead, which the other Mac must allow with Open Anyway.
//
// Settings, transcripts, the word list and the speech models live in the userData folder, not in the app,
// so replacing the app keeps them. Someone building their own copy can set TRANSCRIBER_BUNDLE_ID.

const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {packager} = require('@electron/packager');
const {flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options, FuseState} = require('@electron/fuses');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const NAME = 'Transcriber';
const BUNDLE_ID = process.env.TRANSCRIBER_BUNDLE_ID || 'io.github.brianrenshaw.transcriber';
const HELPER = path.join(root, 'native', 'speech', '.build', 'release', 'transcriber-speech');
const ENTITLEMENTS = path.join(root, 'build', 'entitlements.plist');
const ICON = path.join(root, 'build', 'icon.icns');
const NOTARY_PROFILE = process.env.TRANSCRIBER_NOTARY_PROFILE || 'transcriber';

const share = process.argv.includes('--share');
const sign = share && !process.argv.includes('--adhoc');

// Electron's switches for what the built app can be made to do from outside it, set before it is signed.
// Off: running it as plain Node (ELECTRON_RUN_AS_NODE), NODE_OPTIONS and the --inspect flags, any of which would
// let someone run their own script under this app's signature and whatever permissions people gave it. On: the
// app loads only from its app.asar, and refuses one that no longer matches the hash in its Info.plist.
// Cookie encryption stays off: the app keeps no cookies, and on a copy someone builds for themselves it would
// ask for the keychain again after every rebuild. Every fuse is named, so a new Electron one stops the build
// until it is decided here.
const FUSES = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
};

// The packager copies the app into <Name>.app/Contents/Resources/app; the fuses are in the bundle's Electron.
async function setFuses({buildPath}) {
  const bundle = path.resolve(buildPath, '..', '..', '..');
  if (!bundle.endsWith('.app')) throw new Error(`The fuses expected an app bundle above ${buildPath}`);
  await flipFuses(bundle, {version: FuseVersion.V1, strictlyRequireAllFuses: true, resetAdHocDarwinSignature: true, ...FUSES});
}

async function checkFuses(app) {
  const wire = await getCurrentFuseWire(app);
  const wrong = Object.entries(FUSES).filter(([k, on]) => wire[k] !== (on ? FuseState.ENABLE : FuseState.DISABLE));
  if (wrong.length) throw new Error(`Fuses not set in ${app}: ${wrong.map(([k]) => FuseV1Options[k]).join(', ')}`);
}

// Electron and its helpers get the JavaScript engine's one exception; the speech helper runs Core ML and needs
// none, so it is signed with none.
const signOptions = file => ({hardenedRuntime: true, entitlements: path.basename(file) === 'transcriber-speech' ? [] : ENTITLEMENTS});

function developerId() {
  const out = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {encoding: 'utf8'});
  const m = /"(Developer ID Application: [^"]+)"/.exec(out);
  return m ? m[1] : null;
}

function notaryReady() {
  try { execFileSync('/usr/bin/xcrun', ['notarytool', 'history', '--keychain-profile', NOTARY_PROFILE], {stdio: 'ignore'}); return true; }
  catch { return false; }
}

async function build() {
  const identity = sign ? developerId() : null;
  if (sign && !identity) throw new Error('No "Developer ID Application" certificate in this Mac\'s keychain. Install it, or build an unsigned zip with: npm run share -- --adhoc');
  if (sign && !notaryReady()) throw new Error(`No notarytool login named ${NOTARY_PROFILE}. Save one with: xcrun notarytool store-credentials ${NOTARY_PROFILE} --apple-id <Apple ID> --team-id <Team ID>`);

  execFileSync('/usr/bin/swift', ['build', '-c', 'release', '--package-path', path.join(root, 'native', 'speech')], {stdio: 'inherit'});
  const out = path.join(root, 'out', share ? 'share-build' : 'app');
  if (sign) console.log(`Signing as ${identity}; Apple's notarization takes a few minutes.`);
  const [built] = await packager({
    dir: root, out, overwrite: true, asar: true, prune: true,
    name: NAME, executableName: NAME, appBundleId: BUNDLE_ID,
    appVersion: pkg.version, buildVersion: pkg.version, appCategoryType: 'public.app-category.productivity',
    platform: 'darwin', arch: 'arm64', electronVersion, ...(fs.existsSync(ICON) ? {icon: ICON} : {}),
    // The speech helper goes in Contents/Resources, where src/main/speech.js looks for it and where the
    // signing step finds it.
    // The notices, and Chromium's licenses (Electron leaves them beside the app, outside the zip), go with it.
    extraResource: [HELPER, path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(root, 'node_modules', 'electron', 'dist', 'LICENSES.chromium.html')],
    // Only what the app runs; tests, scripts, the Swift sources and earlier builds stay behind.
    // replica/ (local planning notes, never committed) stays out; LICENSE and the notices ship.
    ignore: [/^\/(test|scripts|out|build|native|replica|design|\.git|\.claude)(\/|$)/, /^\/src\/renderer\/design\.(html|css|js)$/, /^\/(README|CLAUDE|AGENTS|SECURITY)\.md$/, /^\/\.(gitignore|nvmrc|DS_Store)$/],
    afterCopy: [setFuses],
    ...(sign ? {
      osxSign: {identity, optionsForFile: signOptions},
      osxNotarize: {keychainProfile: NOTARY_PROFILE},
    } : {}),
  });
  const app = path.join(built, `${NAME}.app`);
  await checkFuses(app);
  // Without a Developer ID, sign it for this Mac only.
  if (!sign) execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], {stdio: 'inherit'});
  else {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], {stdio: 'inherit'});
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', app], {stdio: 'inherit'});
  }
  return app;
}

(async () => {
  const app = await build();
  if (share) {
    // A zip that keeps the app's signature, its notarization ticket and its permissions intact.
    const dir = path.join(root, 'out', 'share');
    fs.mkdirSync(dir, {recursive: true});
    const zip = path.join(dir, `${NAME}-${pkg.version}.zip`);
    fs.rmSync(zip, {force: true});
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
    console.log(`Built ${zip} (${(fs.statSync(zip).size / 1e6).toFixed(0)} MB)${sign ? ', signed and notarized' : ', unsigned'}`);
    return;
  }
  let dest = '/Applications';
  try { fs.accessSync(dest, fs.constants.W_OK); } catch { dest = path.join(os.homedir(), 'Applications'); fs.mkdirSync(dest, {recursive: true}); }
  const target = path.join(dest, `${NAME}.app`);
  fs.rmSync(target, {recursive: true, force: true});
  execFileSync('/usr/bin/ditto', [app, target]);
  console.log(`Installed ${target}`);
})().catch(e => { console.error(e.message || e); process.exit(1); });

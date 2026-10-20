#!/usr/bin/env node
// Build the Android TV / Fire TV WebView shell APK without Gradle:
//   aapt2 compile/link (manifest + launcher art + dist/app as assets) →
//   javac --release 8 → d8 → zip classes.dex → zipalign → apksigner →
//   platforms/firetv/luma.apk
//
// Requirements (one-time):
//   ANDROID_HOME pointing at an SDK with build-tools 34 and platform
//   android-34, e.g. via cmdline-tools:
//     sdkmanager "build-tools;34.0.0" "platforms;android-34"
//   JDK 17–21 recommended (JDK 25+ needs LUMA_JAVA_RELEASE=8+ and patience).
//
// Usage: pnpm build && node platforms/firetv/build.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..', '..');
const app = path.join(root, 'dist', 'app');
const build = path.join(root, 'dist', 'firetv');
const out = path.join(root, 'platforms', 'firetv', 'luma.apk');

const die = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

function exe(tool, args, options = {}) {
  const result = spawnSync(tool, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    die(`${path.basename(tool)} failed (exit ${result.status ?? result.signal})`);
  }
}

const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    );

const expand = (value) => (value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value);

const byVersion = (a, b) => {
  const va = a.split('.').map(Number);
  const vb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((va[i] ?? 0) !== (vb[i] ?? 0)) return (va[i] ?? 0) - (vb[i] ?? 0);
  }
  return a.localeCompare(b);
};

// --- Locate the SDK -----------------------------------------------------------

const sdk = expand(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '');
if (!sdk || !fs.existsSync(sdk)) {
  die(
    'ANDROID_HOME must point to an Android SDK with build-tools 34 + platform android-34 ' +
      '(cmdline-tools: sdkmanager "build-tools;34.0.0" "platforms;android-34")',
  );
}

const buildToolsRoot =
  process.env.ANDROID_BUILD_TOOLS ??
  (() => {
    const versions = fs
      .readdirSync(path.join(sdk, 'build-tools'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(byVersion);
    if (!versions.length) die('No build-tools installed under the SDK.');
    return path.join(sdk, 'build-tools', versions.at(-1));
  })();

const pick = (name) => {
  const tool = path.join(buildToolsRoot, name);
  if (!fs.existsSync(tool)) die(`${name} missing in ${buildToolsRoot}; reinstall build-tools 34.`);
  return tool;
};
const aapt2 = pick('aapt2');
const d8 = pick('d8');
const zipalign = pick('zipalign');
const apksigner = pick('apksigner');

const platform =
  process.env.ANDROID_PLATFORM ??
  (() => {
    const installed = fs
      .readdirSync(path.join(sdk, 'platforms'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^android-\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
    if (!installed.length)
      die('No Android SDK platform installed (sdkmanager "platforms;android-34").');
    return installed.at(-1);
  })();
const androidJar = path.join(sdk, 'platforms', platform, 'android.jar');
if (!fs.existsSync(androidJar)) die(`android.jar missing for ${platform}.`);
if (platform !== 'android-34') console.log(`warning: compiling against ${platform}`);

// --- Bundle the web app -------------------------------------------------------

if (!fs.existsSync(path.join(app, 'index.html'))) {
  console.log('dist/app is missing; running `pnpm build` first…');
  exe('pnpm', ['build'], { stdio: 'inherit', cwd: root });
}

fs.rmSync(build, { recursive: true, force: true });
for (const dir of [
  path.join(build, 'assets', 'app'),
  path.join(build, 'gen', 'java'),
  path.join(build, 'gen', 'res', 'drawable'),
  path.join(build, 'classes'),
  path.join(build, 'dex'),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.cpSync(app, path.join(build, 'assets', 'app'), { recursive: true });
// Static resources (accessibility config, strings) sit beside the generated art.
fs.cpSync(path.join(root, 'platforms/firetv/android/res'), path.join(build, 'gen', 'res'), {
  recursive: true,
});

// --- Launcher art (no committed binaries; sharp ships with the repo) ----------

const icon = path.join(root, 'public', 'app-icon.svg');
await sharp(icon)
  .resize(192, 192)
  .png()
  .toFile(path.join(build, 'gen/res/drawable/ic_launcher.png'));
const tile = await sharp(icon).resize(96, 96).png().toBuffer();
await sharp({
  create: { width: 320, height: 180, channels: 4, background: { r: 23, g: 25, b: 28, alpha: 1 } },
})
  .composite([{ input: tile, top: 42, left: 112 }])
  .png()
  .toFile(path.join(build, 'gen/res/drawable/ic_banner.png'));

// --- aapt2: resources + manifest + assets into a base APK ---------------------

const manifest = path.join(root, 'platforms/firetv/android/AndroidManifest.xml');
const res = path.join(build, 'gen/res');
const baseApk = path.join(build, 'base.apk');

exe(aapt2, ['compile', '--dir', res, '-o', path.join(build, 'res.zip')]);
exe(aapt2, [
  'link',
  '-o',
  baseApk,
  '-I',
  androidJar,
  '--manifest',
  manifest,
  '--java',
  path.join(build, 'gen/java'),
  '--custom-package',
  'app.luma.firetv',
  '--min-sdk-version',
  '21',
  '--target-sdk-version',
  '34',
  '-A',
  path.join(build, 'assets'),
  path.join(build, 'res.zip'),
]);

// --- javac + d8 -------------------------------------------------------------

const javaDir = path.join(root, 'platforms/firetv/android/java');
const generatedJava = path.join(build, 'gen/java');
const sources = [...(fs.existsSync(generatedJava) ? walk(generatedJava) : []), ...walk(javaDir)];
const release = process.env.LUMA_JAVA_RELEASE ?? '8';
exe('javac', [
  '--release',
  release,
  '-encoding',
  'UTF-8',
  '-classpath',
  androidJar,
  '-d',
  path.join(build, 'classes'),
  ...sources,
]);

exe(d8, [
  '--release',
  '--min-api',
  '21',
  '--lib',
  androidJar,
  '--output',
  path.join(build, 'dex'),
  ...walk(path.join(build, 'classes')),
]);

// --- Assemble: dex into the APK, align, sign ---------------------------------

const unsigned = path.join(build, 'unsigned.apk');
fs.copyFileSync(baseApk, unsigned);
exe('zip', ['-q', '-j', unsigned, path.join(build, 'dex/classes.dex')]);

const aligned = path.join(build, 'aligned.apk');
exe(zipalign, ['-f', '-p', '4', unsigned, aligned]);

// The signing key travels with the repo so reinstalls keep the same identity;
// a lost key means `adb uninstall com.luma.launcher` before the next install.
const keystore = path.join(root, 'platforms/firetv/keystore/debug.jks');
if (!fs.existsSync(keystore)) {
  fs.mkdirSync(path.dirname(keystore), { recursive: true });
  console.log('Generating a fresh debug keystore (paper trail: reinstall wipes app data).');
  exe('keytool', [
    '-genkeypair',
    '-keystore',
    keystore,
    '-storetype',
    'JKS',
    '-alias',
    'luma',
    '-keyalg',
    'RSA',
    '-keysize',
    '2048',
    '-validity',
    '10000',
    '-storepass',
    'android',
    '-keypass',
    'android',
    '-dname',
    'CN=Luma, OU=Shell, O=Luma, C=US',
  ]);
}

exe(apksigner, [
  'sign',
  '--ks',
  keystore,
  '--ks-pass',
  'pass:android',
  '--key-pass',
  'pass:android',
  '--ks-key-alias',
  'luma',
  '--out',
  out,
  aligned,
]);
exe(apksigner, ['verify', out]);

const bytes = fs.readFileSync(out);
console.log(
  `Built platforms/firetv/luma.apk (${Math.round(bytes.length / 1024)} KB, sha256 ${crypto
    .createHash('sha256')
    .update(bytes)
    .digest('hex')
    .slice(0, 16)}…, ${platform})`,
);

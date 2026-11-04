// Build the Fire TV / Android TV APK without Gradle. Luma is the native Rust
// launcher, run by SDL in an SDLActivity:
//   SDL2 (pinned source, NDK CMake) → libSDL2.so
//   cargo (platforms/firetv/native, armv7-linux-androideabi) → libmain.so
//   aapt2 compile/link (manifest, launcher art, .build/assets as assets/luma)
//   → javac --release 8 (shell + SDL's Java) → d8 → zip dex and libs
//   → zipalign → apksigner → platforms/firetv/luma.apk
//
// Requirements (one-time):
//   ANDROID_HOME pointing at an SDK with build-tools 34+, platform android-34+,
//   an NDK (sdkmanager "ndk;27.1.12297006") and CMake ("cmake;3.22.1").
//   rustup target add armv7-linux-androideabi
//   pkg-config, and JDK 17–21 (JDK 25+ needs LUMA_JAVA_RELEASE=8+).
//
// Usage: pnpm assets && node platforms/firetv/build.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..', '..');
const assets = path.join(root, '.build', 'assets');
const cache = path.join(root, '.build', 'firetv');
const build = path.join(cache, 'apk');
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

// --- SDL2 for Android ---------------------------------------------------------

// The same SDL release upstream pins for webOS (tools/webos-runtime.mjs).
const sdlVersion = '2.30.12';
const sdlArchive = `SDL2-${sdlVersion}.tar.gz`;
const sdlSha256 = 'ac356ea55e8b9dd0b2d1fa27da40ef7e238267ccf9324704850d5d47375b48ea';
const abi = 'armeabi-v7a';
const target = 'armv7-linux-androideabi';
const minApi = '21';

const newest = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(byVersion)
        .at(-1)
    : undefined;
const ndk =
  expand(process.env.ANDROID_NDK_HOME || '') ||
  (newest(path.join(sdk, 'ndk')) && path.join(sdk, 'ndk', newest(path.join(sdk, 'ndk'))));
if (!ndk || !fs.existsSync(ndk)) die('No NDK found; install one (sdkmanager "ndk;27.1.12297006").');
const cmakeVersion = newest(path.join(sdk, 'cmake'));
if (!cmakeVersion) die('No CMake found in the SDK (sdkmanager "cmake;3.22.1").');
const cmakeBin = path.join(sdk, 'cmake', cmakeVersion, 'bin');
const host = { darwin: 'darwin-x86_64', linux: 'linux-x86_64' }[process.platform];
if (!host) die(`Unsupported build host ${process.platform}.`);
const toolchain = path.join(ndk, 'toolchains', 'llvm', 'prebuilt', host, 'bin');
const clang = path.join(toolchain, `armv7a-linux-androideabi${minApi}-clang`);

fs.mkdirSync(cache, { recursive: true });
const archive = path.join(cache, sdlArchive);
if (!fs.existsSync(archive)) {
  exe('curl', [
    '-fsSL',
    '-o',
    archive,
    `https://github.com/libsdl-org/SDL/releases/download/release-${sdlVersion}/${sdlArchive}`,
  ]);
}
const archiveSha = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
if (archiveSha !== sdlSha256) {
  fs.rmSync(archive);
  die(`${sdlArchive} has SHA-256 ${archiveSha}, expected ${sdlSha256}; removed it.`);
}
const sdlSource = path.join(cache, `SDL2-${sdlVersion}`);
if (!fs.existsSync(sdlSource)) exe('tar', ['-xzf', archive, '-C', cache]);
const sdlBuild = path.join(cache, `sdl-${abi}`);
const libSDL = path.join(sdlBuild, 'libSDL2.so');
if (!fs.existsSync(libSDL)) {
  exe(path.join(cmakeBin, 'cmake'), [
    '-S',
    sdlSource,
    '-B',
    sdlBuild,
    '-G',
    'Ninja',
    `-DCMAKE_MAKE_PROGRAM=${path.join(cmakeBin, 'ninja')}`,
    `-DCMAKE_TOOLCHAIN_FILE=${path.join(ndk, 'build/cmake/android.toolchain.cmake')}`,
    `-DANDROID_ABI=${abi}`,
    `-DANDROID_PLATFORM=android-${minApi}`,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DSDL_SHARED=ON',
    '-DSDL_STATIC=OFF',
    '-DSDL_TEST=OFF',
  ]);
  exe(path.join(cmakeBin, 'ninja'), ['-C', sdlBuild]);
}

// --- Luma as libmain.so -------------------------------------------------------

const nativeCrate = path.join(root, 'platforms/firetv/native');
const versionOf = (manifest) =>
  /^version = "([^"]+)"/m.exec(fs.readFileSync(manifest, 'utf8'))?.[1];
const version = versionOf(path.join(root, 'Cargo.toml'));
if (versionOf(path.join(nativeCrate, 'Cargo.toml')) !== version) {
  die(`platforms/firetv/native/Cargo.toml must use the root package's version ${version}.`);
}
// sdl2-sys asks pkg-config for SDL; point it at the Android build alone.
const pkgconfig = path.join(cache, 'pkgconfig');
fs.mkdirSync(pkgconfig, { recursive: true });
fs.writeFileSync(
  path.join(pkgconfig, 'sdl2.pc'),
  `Name: sdl2\nDescription: SDL2 for Android ${abi}\nVersion: ${sdlVersion}\n` +
    `Libs: -L${sdlBuild} -lSDL2\nCflags:\n`,
);
const targetEnv = target.replaceAll('-', '_');
exe('cargo', ['build', '--locked', '--release', '--target', target], {
  cwd: nativeCrate,
  env: {
    ...process.env,
    [`CC_${targetEnv}`]: clang,
    [`AR_${targetEnv}`]: path.join(toolchain, 'llvm-ar'),
    [`CARGO_TARGET_${targetEnv.toUpperCase()}_LINKER`]: clang,
    PKG_CONFIG_ALLOW_CROSS: '1',
    PKG_CONFIG_PATH: '',
    PKG_CONFIG_LIBDIR: pkgconfig,
  },
});
const libMain = path.join(nativeCrate, 'target', target, 'release', 'libmain.so');

// --- Stage assets, resources and native libraries ------------------------------

if (!fs.existsSync(path.join(assets, 'font.ttf'))) {
  die('.build/assets is missing; run `pnpm assets` first.');
}

fs.rmSync(build, { recursive: true, force: true });
for (const dir of [
  path.join(build, 'assets'),
  path.join(build, 'gen', 'java'),
  path.join(build, 'gen', 'res', 'drawable'),
  path.join(build, 'classes'),
  path.join(build, 'dex'),
  path.join(build, 'native', 'lib', abi),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

// MainActivity unpacks assets/luma to app storage, where Luma reads it as --assets.
fs.cpSync(assets, path.join(build, 'assets', 'luma'), { recursive: true });
// Shell-owned assets, such as the T3 Code web client's TV injection.
fs.cpSync(path.join(root, 'platforms/firetv/android/assets'), path.join(build, 'assets'), {
  recursive: true,
});
// Static resources (accessibility config, strings) sit beside the generated art.
fs.cpSync(path.join(root, 'platforms/firetv/android/res'), path.join(build, 'gen', 'res'), {
  recursive: true,
});
fs.copyFileSync(libSDL, path.join(build, 'native', 'lib', abi, 'libSDL2.so'));
fs.copyFileSync(libMain, path.join(build, 'native', 'lib', abi, 'libmain.so'));

// --- Launcher art (no committed binaries; sharp ships with the repo) ----------

const icon = path.join(root, 'assets', 'app-icon.svg');
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
  minApi,
  '--target-sdk-version',
  '34',
  '-A',
  path.join(build, 'assets'),
  path.join(build, 'res.zip'),
]);

// --- javac + d8 -------------------------------------------------------------

const javaDir = path.join(root, 'platforms/firetv/android/java');
const generatedJava = path.join(build, 'gen/java');
const sdlJava = path.join(sdlSource, 'android-project/app/src/main/java');
const sources = [
  ...(fs.existsSync(generatedJava) ? walk(generatedJava) : []),
  ...walk(javaDir),
  ...walk(sdlJava),
];
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
  minApi,
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
exe('zip', ['-q', '-r', unsigned, 'lib'], { cwd: path.join(build, 'native') });

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

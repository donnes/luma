#!/usr/bin/env node
// Package the built web app as an unsigned Tizen .wgt.
// Signing requires a Samsung TV certificate bound to the device DUID;
// use Tizen Studio's certificate manager, then:
//   tizen package -t wgt -s <profile> -- .

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const root = new URL('../../', import.meta.url).pathname;
const dist = `${root}dist`;
const app = `${dist}/app`;
const staging = `${dist}/tizen/com.luma.launcher`;

const config = `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" id="com.luma.launcher" version="1.0.1">
  <name>Luma</name>
  <description>A modern, remote-first TV launcher.</description>
  <icon src="icon.png"/>
  <content src="index.html"/>
  <tizen:application id="com.luma.launcher" package="luma" required_version="2.3"/>
  <tizen:setting screen-orientation="landscape" background-support="disable" encryption="disable" install-location="auto"/>
  <tizen:privilege name="http://tizen.org/privilege/application.launch"/>
  <tizen:privilege name="http://tizen.org/privilege/application.info"/>
</widget>
`;

mkdirSync(staging, { recursive: true });
execSync(`cp -R "${app}/." "${staging}/"`);
writeFileSync(`${staging}/config.xml`, config);

const wgt = `${dist}/com.luma.launcher.wgt`;
rmSync(wgt, { force: true });
// An unsigned .wgt installs only on TVs in Developer Mode with a matching
// author certificate; keep the artifact layout identical to a signed one.
execSync(`(cd "${staging}" && zip -qr "${wgt}" .)`);

const bytes = readFileSync(wgt);
const sha256 = createHash('sha256').update(bytes).digest('hex');
console.log(
  `Built com.luma.launcher.wgt (${Math.round(bytes.length / 1024)} KB, sha256 ${sha256.slice(0, 16)}…, unsigned)`,
);

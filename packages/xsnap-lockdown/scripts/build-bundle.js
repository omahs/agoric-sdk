#! /usr/bin/env node
import '@endo/init';
import path from 'path';
import { promises as fsp } from 'fs';
import crypto from 'crypto';

import bundleSource from '@endo/bundle-source';
import { bundlePaths, entryPaths, hashPaths } from '../src/paths.js';

/** @param {Uint8Array} bytes */
const computeSha256 = bytes => {
  const hash = crypto.createHash('sha256');
  hash.update(bytes);
  return hash.digest().toString('hex');
};

const make = async name => {
  await fsp.mkdir(path.dirname(bundlePaths[name]), { recursive: true });
  const format = 'nestedEvaluate';
  const bundle = await bundleSource(entryPaths[name], { format });
  const bundleString = JSON.stringify(bundle);
  const sha256 = computeSha256(bundleString);
  await fsp.writeFile(bundlePaths[name], bundleString);
  await fsp.writeFile(hashPaths[name], `${sha256}\n`);
  return { length: bundleString.length, sha256, where: bundlePaths[name] };
};

const run = async () => {
  const ld = await make('lockdown');
  console.log(`wrote ${ld.where}: ${ld.length} bytes`);
  console.log(`lockdown.bundle SHA256: ${ld.sha256}`);
  await make('lockdownDebug');
};

run().catch(err => console.log(err));

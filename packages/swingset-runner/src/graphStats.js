#!/usr/bin/env -S node -r esm

import { dataGraphApp } from './dataGraphApp.js';

export async function main() {
  // prettier-ignore
  await dataGraphApp(
    'block',
    'Block #',
    null,
    'Count',
    null,
  );
}

main();

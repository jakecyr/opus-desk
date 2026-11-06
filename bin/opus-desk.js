#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runCli } from '../server/cli.js';

runCli(process.argv.slice(2), {
  entry: fileURLToPath(import.meta.url),
  staticRoot: fileURLToPath(new URL('../dist', import.meta.url)),
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

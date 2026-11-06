import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const stage = path.resolve('build', 'package');
await fs.mkdir(stage, { recursive: true });
await fs.copyFile('build/opus-desk', path.join(stage, 'opus-desk'));
await fs.copyFile('LICENSE', path.join(stage, 'LICENSE'));
await fs.copyFile(
  'build/THIRD_PARTY_NOTICES.txt',
  path.join(stage, 'THIRD_PARTY_NOTICES.txt'),
);
const archive = path.resolve(
  'build',
  `opus-desk-${process.platform}-${process.arch}.tar.gz`,
);
execFileSync('tar', [
  '-czf',
  archive,
  '-C',
  stage,
  'opus-desk',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
]);
console.log(`Packaged ${archive}`);

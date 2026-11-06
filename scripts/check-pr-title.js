import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const event = JSON.parse(
  await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8'),
);
const title = event.pull_request?.title;
if (!title) throw new Error('A pull request event is required');
// Pass untrusted PR text through stdin, never through a shell command.
const result = spawnSync(
  process.execPath,
  ['node_modules/@commitlint/cli/cli.js'],
  {
    input: title,
    stdio: ['pipe', 'inherit', 'inherit'],
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

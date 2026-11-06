import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getAsset, getAssetKeys } from 'node:sea';
import { runCli } from '../server/cli.js';
import { version } from '../server/version.js';

async function staticRoot() {
  const data =
    process.env.OPUSDESK_DATA_DIR ||
    path.join(os.homedir(), '.local', 'share', 'prquay');
  const root = path.join(data, 'runtime', version, 'dist');
  for (const name of getAssetKeys()) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, Buffer.from(getAsset(name)), { mode: 0o600 });
  }
  return root;
}

runCli(process.argv.slice(2), { staticRoot }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

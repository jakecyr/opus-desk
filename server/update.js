import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = 'https://github.com/jakecyr/opus-desk/releases';

export async function updateBinary(executable = process.execPath) {
  if (
    !['darwin', 'linux'].includes(process.platform) ||
    !['arm64', 'x64'].includes(process.arch)
  )
    throw new Error('Updates support macOS and Linux on arm64 and x64.');
  const curl = [
    '--fail',
    '--silent',
    '--show-error',
    '--location',
    '--proto',
    '=https',
    '--tlsv1.2',
  ];
  const { stdout } = await exec('curl', [
    ...curl,
    '--output',
    '/dev/null',
    '--write-out',
    '%{url_effective}',
    `${repo}/latest`,
  ]);
  const match = stdout
    .trim()
    .match(
      /^https:\/\/github\.com\/jakecyr\/opus-desk\/releases\/tag\/(v\d+\.\d+\.\d+)$/,
    );
  if (!match) throw new Error('Could not resolve the latest stable release.');
  const version = match[1];
  const asset = `opus-desk-${process.platform}-${process.arch}.tar.gz`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-desk-update-'));
  let staged;
  try {
    const archive = path.join(temp, asset);
    const sums = path.join(temp, 'SHA256SUMS');
    console.log(`Downloading Opus Desk ${version}…`);
    for (const [name, target] of [
      [asset, archive],
      ['SHA256SUMS', sums],
    ])
      await exec('curl', [
        ...curl,
        `${repo}/download/${version}/${name}`,
        '-o',
        target,
      ]);
    const lines = (await fs.readFile(sums, 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line.endsWith(`  ${asset}`));
    const expected = lines.length === 1 ? lines[0].split(/\s+/)[0] : '';
    if (!/^[0-9a-f]{64}$/.test(expected))
      throw new Error(`Missing or invalid checksum for ${asset}.`);
    const actual = createHash('sha256')
      .update(await fs.readFile(archive))
      .digest('hex');
    if (actual !== expected)
      throw new Error('Checksum mismatch; refusing to update.');
    await exec('tar', ['-xzf', archive, '-C', temp, 'opus-desk']);
    const target = await fs.realpath(executable);
    staged = path.join(
      path.dirname(target),
      `.opus-desk-${randomBytes(12).toString('hex')}`,
    );
    await fs.copyFile(path.join(temp, 'opus-desk'), staged, 1);
    await fs.chmod(staged, 0o755);
    await fs.rename(staged, target);
    console.log(
      `Updated ${target} to ${version}. Run opus-desk restart to update a running daemon.`,
    );
  } finally {
    if (staged) await fs.rm(staged, { force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
}

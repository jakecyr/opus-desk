import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { inject } from 'postject';

if (
  !['darwin', 'linux'].includes(process.platform) ||
  !['arm64', 'x64'].includes(process.arch)
) {
  throw new Error('Binary builds support macOS/Linux on arm64/x64');
}
const output = path.resolve('build');
await fs.mkdir(output, { recursive: true });
const main = path.join(output, 'opus-desk.cjs');
const bundled = await build({
  entryPoints: ['scripts/sea-entry.js'],
  outfile: main,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  metafile: true,
});
const packageRoots = new Set();
for (const name of Object.keys(bundled.metafile.inputs)) {
  if (!name.includes('node_modules/')) continue;
  let dir = path.dirname(path.resolve(name));
  while (dir !== path.dirname(dir)) {
    try {
      await fs.access(path.join(dir, 'package.json'));
      packageRoots.add(dir);
      break;
    } catch {
      dir = path.dirname(dir);
    }
  }
}
// Include frontend runtime dependencies as well as the bundled server modules.
for (const dir of execFileSync(
  'npm',
  ['ls', '--omit=dev', '--all', '--parseable'],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n')) {
  if (dir.includes('node_modules/')) packageRoots.add(dir);
}
const notices = ['Opus Desk bundled third-party licenses\n'];
for (const dir of [...packageRoots].sort()) {
  const pkg = JSON.parse(
    await fs.readFile(path.join(dir, 'package.json'), 'utf8'),
  );
  notices.push(
    `\n=== ${pkg.name} ${pkg.version} (${pkg.license || 'see below'}) ===\n`,
  );
  for (const name of await fs.readdir(dir)) {
    if (/^(licen[sc]e|copying|notice)([.-]|$)/i.test(name))
      notices.push(await fs.readFile(path.join(dir, name), 'utf8'));
  }
}
const nodeLicense = path.resolve(path.dirname(process.execPath), '../LICENSE');
notices.push(
  `\n=== Node.js ${process.version} and bundled dependencies ===\n`,
  await fs.readFile(nodeLicense, 'utf8'),
);
await fs.writeFile(
  path.join(output, 'THIRD_PARTY_NOTICES.txt'),
  notices.join('\n'),
);
const assets = {};
for (const file of await fs.readdir('dist', {
  recursive: true,
  withFileTypes: true,
})) {
  if (file.isFile()) {
    const absolute = path.join(file.parentPath, file.name);
    assets[path.relative('dist', absolute).split(path.sep).join('/')] =
      path.resolve(absolute);
  }
}
if (!assets['index.html'])
  throw new Error('Run npm run build before building a binary');
const blob = path.join(output, 'sea.blob');
const config = path.join(output, 'sea-config.json');
await fs.writeFile(
  config,
  JSON.stringify({
    main,
    output: blob,
    assets,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', config], {
  stdio: 'inherit',
});
const executable = path.join(output, 'opus-desk');
await fs.copyFile(process.execPath, executable);
await fs.chmod(executable, 0o755);
if (process.platform === 'darwin')
  execFileSync('codesign', ['--remove-signature', executable]);
await inject(executable, 'NODE_SEA_BLOB', await fs.readFile(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});
if (process.platform === 'darwin')
  execFileSync('codesign', ['--sign', '-', executable]);
console.log(`Built ${executable} (${process.platform}/${process.arch})`);

import path from 'node:path';
import { runtimeSmoke } from './runtime-smoke.js';

await runtimeSmoke(
  path.resolve(process.env.OPUSDESK_BINARY || 'build/opus-desk'),
);
console.log(
  'Binary smoke passed: embedded assets, configuration, detached start/status/restart/stop, and local host checks.',
);

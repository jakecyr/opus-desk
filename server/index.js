import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './app.js';
import { startAgentHost } from './agent-host.js';

(process.argv[2] === 'agent-host'
  ? startAgentHost()
  : startServer({
      staticRoot:
        process.env.OPUSDESK_STATIC_ROOT ||
        path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
    })
).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

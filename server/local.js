// Only loopback names are accepted, even when a friendly URL is configured.
export function localOptions(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 4317);
  const hostname =
    options.hostname ?? process.env.OPUSDESK_HOSTNAME ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  if (
    hostname !== '127.0.0.1' &&
    hostname !== 'localhost' &&
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+localhost$/.test(hostname)
  ) {
    throw new Error(
      'Hostname must be 127.0.0.1, localhost, or a name ending in .localhost',
    );
  }
  return { port, hostname };
}

export function acceptsHost(authority, hostname, port) {
  if (typeof authority !== 'string') return false;
  const names = new Set(['127.0.0.1', 'localhost', '[::1]', hostname]);
  return [...names].some(
    (name) =>
      authority === `${name}:${port}` || (port === 80 && authority === name),
  );
}

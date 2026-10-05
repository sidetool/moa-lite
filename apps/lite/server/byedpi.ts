import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const byedpiBinary = resolve(import.meta.dirname, '../../../vendor/byedpi/ciadpi-linux-x64');

/** Request-scoped native proxy: no daemon, external listening socket or warm-instance dependency. */
export async function withByeDpi<T>(signal: AbortSignal, run: (proxy: string | undefined) => Promise<T>,
  options: { enabled?: boolean; binary?: string; strategy?: string } = {}): Promise<T> {
  signal.throwIfAborted();
  const enabled = options.enabled ?? process.env.BYEDPI_ENABLED !== '0';
  if (!enabled) return run(undefined);
  const strategy = options.strategy ?? process.env.BYEDPI_STRATEGY ?? 'tlsrec';
  if (!['tlsrec', 'disorder'].includes(strategy)) throw new Error('byedpi_invalid_strategy');
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('byedpi_platform_unsupported');
  // Ask the OS for an unused loopback port; a bind race fails closed during startup.
  const reservation = createServer();
  await new Promise<void>((yes, no) => { reservation.once('error', no); reservation.listen(0, '127.0.0.1', yes); });
  const port = (reservation.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((yes, no) => reservation.close(error => error ? no(error) : yes()));
  signal.throwIfAborted();
  const child = spawn(options.binary ?? byedpiBinary, [
    '--ip', '127.0.0.1', '--port', String(port), '--no-domain', '--no-udp', '--max-conn', '8',
    ...(strategy === 'disorder' ? ['--disorder', '1', '--auto=torst'] : []),
    '--tlsrec', '1+s', '--timeout', '3',
  ], { stdio: 'ignore', shell: false });
  let failure: Error | undefined;
  const closed = new Promise<void>(yes => {
    child.once('error', error => { failure = error; });
    child.once('close', () => yes());
  });
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const until = Date.now() + 3000;
    for (;;) {
      signal.throwIfAborted();
      if (failure || child.exitCode !== null || child.signalCode !== null || Date.now() > until)
        throw new Error('byedpi_start_failed', { cause: failure });
      const ready = await new Promise<boolean>(yes => {
        const socket = connect({ host: '127.0.0.1', port, signal });
        socket.setTimeout(100);
        let settled = false;
        const done = (value: boolean) => { if (!settled) { settled = true; socket.destroy(); yes(value); } };
        // Verify a SOCKS5 greeting, not just an open port.
        socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
        socket.once('data', data => done(data.length === 2 && data[0] === 5 && data[1] === 0));
        socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
        socket.once('close', () => done(false));
      });
      if (ready) break;
      await delay(15, undefined, { signal });
    }
    signal.throwIfAborted();
    if (child.exitCode !== null || failure) throw new Error('byedpi_start_failed');
    return await run(`socks5://127.0.0.1:${port}`);
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
    await closed;
  }
}

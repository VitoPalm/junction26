import type { Logger } from './logger.ts';

export interface ShutdownHandle {
  /** Resolves once a shutdown signal arrives. */
  readonly signalled: Promise<string>;
  readonly aborted: AbortSignal;
}

/**
 * Runs `stop` once on SIGTERM/SIGINT, then exits. A second signal, or `stop`
 * exceeding `graceMs`, exits immediately with code 1.
 */
export function onShutdown(logger: Logger, graceMs: number, stop: (signal: string) => Promise<void>): ShutdownHandle {
  const controller = new AbortController();
  let resolveSignal!: (s: string) => void;
  const signalled = new Promise<string>((r) => (resolveSignal = r));
  let stopping = false;

  const handler = (signal: string) => {
    if (stopping) {
      logger.warn('second shutdown signal, exiting now', { signal });
      process.exit(1);
    }
    stopping = true;
    controller.abort();
    resolveSignal(signal);
    logger.info('shutting down', { signal, graceMs });
    const timer = setTimeout(() => {
      logger.error('shutdown grace period exceeded, exiting', { graceMs });
      process.exit(1);
    }, graceMs);
    timer.unref();
    stop(signal).then(
      () => {
        logger.info('shutdown complete');
        process.exit(0);
      },
      (err: unknown) => {
        logger.error('shutdown failed', { err });
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return { signalled, aborted: controller.signal };
}

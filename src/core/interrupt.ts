/**
 * Ctrl+C that actually stops.
 *
 * Long work (`--reindex`) can be stuck somewhere unabortable — loading
 * or downloading a model — where an AbortSignal is only noticed between
 * batches. Racing the work against the signal means the first Ctrl+C returns
 * immediately whatever the work is doing; a second one is the user saying they
 * meant it.
 */

/** The bit of `process` this needs. Tests inject an EventEmitter. */
export interface SignalTarget {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface WithInterruptOptions {
  /** Defaults to `['SIGINT']`. */
  signals?: NodeJS.Signals[] | undefined;
  /** Defaults to `process`. */
  target?: SignalTarget | undefined;
  /** Run on the first signal, after the work is asked to stop. */
  onInterrupt?: (() => void) | undefined;
  /** Run on the second signal. Defaults to exiting with 130 straight away. */
  onForceExit?: (() => void) | undefined;
}

export interface InterruptOutcome<T> {
  /** Present only when the work finished first. */
  value?: T;
  /** True when a signal won the race; the work may still be running. */
  interrupted: boolean;
}

/** Exit code for "terminated by SIGINT", as every shell expects. */
export const SIGINT_EXIT_CODE = 130;

/**
 * Runs `work` with an AbortSignal, returning as soon as either the work
 * finishes or the first signal arrives. Rejections from `work` propagate; a
 * rejection that arrives after an interrupt is swallowed, not left unhandled.
 */
export async function withInterrupt<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: WithInterruptOptions = {},
): Promise<InterruptOutcome<T>> {
  const signals = options.signals ?? (['SIGINT'] as NodeJS.Signals[]);
  const target = options.target ?? (process as unknown as SignalTarget);
  const forceExit =
    options.onForceExit ??
    ((): void => {
      process.exit(SIGINT_EXIT_CODE);
    });

  const controller = new AbortController();
  let count = 0;
  let announce: () => void = () => {};
  const interrupted = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const onSignal = (): void => {
    count += 1;
    if (count === 1) {
      controller.abort();
      options.onInterrupt?.();
      announce();
      return;
    }
    forceExit();
  };

  for (const signal of signals) target.on(signal, onSignal);
  try {
    const outcome = await Promise.race([
      work(controller.signal).then(
        (value) => ({ kind: 'done', value }) as const,
        (error: unknown) => ({ kind: 'failed', error }) as const,
      ),
      interrupted.then(() => ({ kind: 'interrupted' }) as const),
    ]);
    if (outcome.kind === 'failed') throw outcome.error;
    if (outcome.kind === 'interrupted') return { interrupted: true };
    return { value: outcome.value, interrupted: false };
  } finally {
    for (const signal of signals) target.off(signal, onSignal);
  }
}

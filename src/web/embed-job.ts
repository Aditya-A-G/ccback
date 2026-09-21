import { type Db, type Embedder, enableSemantic, semanticStatus } from '../core/index.js';

/** Progress of smart-search setup, as reported by `/api/status`. */
export interface EmbedJobState {
  running: boolean;
  /** What it is doing: waiting, loading the model, or embedding. */
  phase: 'idle' | 'model' | 'embed';
  embedded: number;
  total: number;
  /** True once a run finished without being cancelled. */
  done: boolean;
  /** User-facing message when the last run failed, else null. */
  error: string | null;
}

export interface EmbedJobOptions {
  db: Db;
  embedder?: Embedder | undefined;
  appHome?: string | undefined;
}

/**
 * One background embedding run per server. Lives on the server instance, never
 * in module scope, so several servers in one process cannot see each other's
 * progress.
 */
export class EmbedJob {
  private state: EmbedJobState = {
    running: false,
    phase: 'idle',
    embedded: 0,
    total: 0,
    done: false,
    error: null,
  };
  private controller: AbortController | null = null;
  private promise: Promise<void> | null = null;

  snapshot(): EmbedJobState {
    return { ...this.state };
  }

  get running(): boolean {
    return this.state.running;
  }

  /**
   * Starts a run unless one is already going. Resolves immediately: progress is
   * polled through `/api/status`.
   */
  start(options: EmbedJobOptions): boolean {
    if (this.state.running) return false;
    const controller = new AbortController();
    this.controller = controller;
    this.state = { running: true, phase: 'model', embedded: 0, total: 0, done: false, error: null };

    this.promise = (async () => {
      try {
        await enableSemantic({
          db: options.db,
          embedder: options.embedder,
          appHome: options.appHome,
          signal: controller.signal,
          onProgress: ({ phase, done, total }) => {
            if (phase === 'embed') {
              this.state.phase = 'embed';
              if (done !== undefined) this.state.embedded = done;
              if (total !== undefined) this.state.total = total;
            } else if (phase === 'model') {
              this.state.phase = 'model';
            }
          },
        });
        this.state.done = !controller.signal.aborted;
      } catch (err) {
        this.state.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.state.running = false;
        this.state.phase = 'idle';
        this.controller = null;
      }
    })();
    return true;
  }

  /**
   * Starts only when there is something to do and something to do it with.
   * This is what makes smart search set itself up on server start without
   * nagging a keyword-only install.
   */
  startIfPending(options: EmbedJobOptions): boolean {
    const state = semanticStatus({ db: options.db, embedder: options.embedder });
    if (!state.runtimeInstalled || state.pendingChunks === 0) return false;
    return this.start(options);
  }

  /** Cancels a run in flight and waits for it to unwind. Progress is kept. */
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.promise?.catch(() => undefined);
  }
}

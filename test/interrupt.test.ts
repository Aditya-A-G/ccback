/**
 * Ctrl+C during `--reindex`.
 *
 * The hard case is the model load: it is not abortable, so the signal has to
 * win a race rather than be polled for. Nothing here downloads a model; the
 * unabortable work is simulated, and the embedding side uses the fake embedder.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SIGINT_EXIT_CODE, withInterrupt } from '../src/core/interrupt.js';
import { embedMissing } from '../src/core/semantic.js';
import { syncIndex } from '../src/core/indexer.js';
import {
  childEnv,
  cleanupTempDirs,
  fakeEmbedder,
  makeFixture,
  openFixtureDb,
  tempDir,
  userMessage,
  writeSession,
} from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterAll(cleanupTempDirs);

/** A stand-in for `process` that a test can fire signals at. */
function fakeTarget(): EventEmitter & { fire: () => void } {
  const emitter = new EventEmitter() as EventEmitter & { fire: () => void };
  emitter.fire = () => emitter.emit('SIGINT');
  return emitter;
}

describe('withInterrupt', () => {
  it('returns as soon as the first signal arrives, even if the work never finishes', async () => {
    const target = fakeTarget();
    let sawAbort = false;
    const started = Date.now();

    const promise = withInterrupt(
      (signal) =>
        new Promise<string>(() => {
          // Never settles: this is the model still loading.
          signal.addEventListener('abort', () => {
            sawAbort = true;
          });
        }),
      { target, onForceExit: () => {} },
    );
    setTimeout(() => target.fire(), 10);

    const outcome = await promise;
    expect(outcome.interrupted).toBe(true);
    expect(outcome.value).toBeUndefined();
    expect(sawAbort).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(target.listenerCount('SIGINT')).toBe(0);
  });

  it('returns the value and removes its listener when the work wins', async () => {
    const target = fakeTarget();
    const outcome = await withInterrupt(async () => 'done', { target, onForceExit: () => {} });
    expect(outcome).toEqual({ value: 'done', interrupted: false });
    expect(target.listenerCount('SIGINT')).toBe(0);
  });

  it('calls the force-exit hook on the second signal only', async () => {
    const target = fakeTarget();
    let forced = 0;
    const promise = withInterrupt(() => new Promise<void>(() => {}), {
      target,
      onForceExit: () => {
        forced += 1;
      },
    });
    target.fire();
    await promise;
    expect(forced).toBe(0);

    // The handler is detached once it has returned; the CLI exits at this point.
    target.fire();
    expect(forced).toBe(0);
  });

  it('keeps forcing available while the work is still running', async () => {
    const target = fakeTarget();
    let forced = 0;
    let release: () => void = () => {};
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    const promise = withInterrupt(() => work, {
      target,
      onForceExit: () => {
        forced += 1;
        release();
      },
    });
    target.fire();
    target.fire();
    await promise;
    expect(forced).toBe(1);
  });

  it('propagates a failure, and swallows one that arrives after an interrupt', async () => {
    const target = fakeTarget();
    await expect(
      withInterrupt(async () => {
        throw new Error('nope');
      }, { target, onForceExit: () => {} }),
    ).rejects.toThrow('nope');

    const late = fakeTarget();
    const outcome = await (async () => {
      const promise = withInterrupt(
        () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('too late')), 20)),
        { target: late, onForceExit: () => {} },
      );
      late.fire();
      return promise;
    })();
    expect(outcome.interrupted).toBe(true);
    // An unhandled rejection here would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});

describe('embedding survives the interrupt', () => {
  it('keeps every batch it finished before stopping, and resumes later', async () => {
    const fixture = makeFixture();
    for (let i = 0; i < 6; i += 1) {
      writeSession(fixture.projectsDir, `-tmp-e${i}`, `emb-${i}`, [
        userMessage(
          `message ${i} with enough words in it to make a chunk worth embedding for the test`,
          { cwd: `/tmp/e${i}` },
        ),
      ]);
    }
    const db = openFixtureDb(fixture);
    await syncIndex(db, { projectsDir: fixture.projectsDir });

    const controller = new AbortController();
    const embedder = fakeEmbedder();
    let batches = 0;
    const first = await embedMissing(db, embedder, {
      batchSize: 2,
      onProgress: () => {
        batches += 1;
        if (batches === 1) controller.abort();
      },
      signal: controller.signal,
    });

    expect(first.aborted).toBe(true);
    expect(first.embedded).toBe(2);
    const kept = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get() as { n: number };
    expect(kept.n).toBe(2);

    const second = await embedMissing(db, embedder, { batchSize: 2 });
    expect(second.aborted).toBe(false);
    expect(second.remaining).toBe(0);
    db.close();
  });
});

/**
 * Windows has no SIGINT to deliver: `child.kill('SIGINT')` there is
 * TerminateProcess, so the child's handler never runs and the exit code is
 * never 130. The signal path is real behaviour, so it is skipped rather than
 * rewritten into something that passes without testing anything.
 */
describe.skipIf(process.platform === 'win32')('a real SIGINT', () => {
  /** Runs a tiny module that uses withInterrupt, so a real signal is delivered. */
  function runHarness(source: string): Promise<{ code: number; ms: number; child: ReturnType<typeof spawn> }> {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: projectRoot,
      // The harness touches no files, but it still gets its own app home:
      // nothing spawned by a test may inherit one from the developer's shell.
      env: childEnv({ CCBACK_HOME: tempDir('ccback-interrupt-home-') }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const started = Date.now();
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        resolve({ code: code ?? (signal === 'SIGINT' ? 130 : -1), ms: Date.now() - started, child });
      });
      // The harness says `ready` once its handler is installed. Signalling on a
      // timer instead races a slow CI box: a SIGINT that lands before the
      // listener exists hits Node's default disposition and kills the process
      // outright, which looks exactly like the bug this test is here to catch.
      void waitForReady(child).then(() => child.kill('SIGINT'));
    });
  }

  /** Resolves when the harness has printed `ready` on stdout. */
  function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
    return new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`harness never said ready: ${out}`)), 15_000);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
        if (out.includes('ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  it('exits 130 promptly even while unabortable work is still running', async () => {
    // `new Promise(() => {})` stands in for a model load: no abort, no result.
    const source = `
      import { withInterrupt, SIGINT_EXIT_CODE } from './dist/core/index.js';
      const keepAlive = setInterval(() => {}, 1000);
      const outcome = await withInterrupt(() => new Promise(() => { process.stdout.write('ready\\n'); }));
      clearInterval(keepAlive);
      process.exit(outcome.interrupted ? SIGINT_EXIT_CODE : 0);
    `;
    const result = await runHarness(source);
    expect(result.code).toBe(SIGINT_EXIT_CODE);
    expect(result.ms).toBeLessThan(3000);
  }, 20_000);

  it('a second Ctrl+C gets out even if the shutdown after the first one hangs', async () => {
    const source = `
      import { withInterrupt } from './dist/core/index.js';
      const keepAlive = setInterval(() => {}, 1000);
      // 'ready' is said from inside the guarded work, so the Ctrl+C handler
      // is in place before the test sends the signal.
      await withInterrupt(() => new Promise(() => { process.stdout.write('ready\\n'); }));
      process.stdout.write('shutting-down\\n');
      // A shutdown that never finishes: only a second Ctrl+C can end this.
      await new Promise(() => {});
      clearInterval(keepAlive);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: projectRoot,
      // The harness touches no files, but it still gets its own app home:
      // nothing spawned by a test may inherit one from the developer's shell.
      env: childEnv({ CCBACK_HOME: tempDir('ccback-interrupt-home-') }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const started = Date.now();
    const exited = new Promise<{ code: number; ms: number }>((resolve) => {
      child.on('exit', (code, signal) =>
        resolve({ code: code ?? (signal === 'SIGINT' ? SIGINT_EXIT_CODE : -1), ms: Date.now() - started }),
      );
    });
    // Both signals are sent on what the child says it is doing, not on a timer:
    // the first once its handler exists, the second once the first one has been
    // taken and the unfinishable shutdown has begun.
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    const sawLine = async (needle: string): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (!out.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`never said ${needle}: ${out}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    await sawLine('ready');
    child.kill('SIGINT');
    await sawLine('shutting-down');
    child.kill('SIGINT');

    const result = await exited;
    expect(result.code).toBe(SIGINT_EXIT_CODE);
    expect(result.ms).toBeLessThan(5000);
  }, 20_000);
});

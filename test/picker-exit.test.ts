/**
 * Two ways the picker used to refuse to let go of the terminal.
 *
 * 1. `^O` twice in quick succession started two web servers; one was leaked,
 *    kept its listener open, and ccfind then never exited.
 * 2. Quitting while the smart-search model was still loading waited for a load
 *    no AbortSignal reaches, so the shell prompt came back minutes later.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTranscriptOpener, EXIT_GRACE_MS, finishInteractive, type WebBridge } from '../src/cli.js';

interface FakeServer {
  url: string;
  closed: number;
  autoEmbed: boolean | undefined;
}

function fakeWeb(options: { running?: string | undefined; startDelayMs?: number } = {}): {
  bridge: WebBridge;
  servers: FakeServer[];
  starts: number;
  opened: string[];
} {
  const servers: FakeServer[] = [];
  const opened: string[] = [];
  const state = { starts: 0 };
  const bridge: WebBridge = {
    findRunningWeb: async () => (options.running === undefined ? null : { url: options.running }),
    startWebServer: async (opts) => {
      state.starts += 1;
      const index = state.starts;
      // The real one takes a while to bind; that window is the whole bug.
      await new Promise((resolve) => setTimeout(resolve, options.startDelayMs ?? 20));
      const server: FakeServer = {
        url: `http://127.0.0.1:${4777 + index}`,
        closed: 0,
        autoEmbed: opts.autoEmbed,
      };
      servers.push(server);
      return {
        url: server.url,
        close: async () => {
          server.closed += 1;
        },
      };
    },
    transcriptUrl: (handle, sessionId, messageId) =>
      `${handle.url}/s/${sessionId}${messageId === undefined ? '' : `?m=${messageId}`}`,
    openInBrowser: (url) => {
      opened.push(url);
      return true;
    },
  };
  return {
    bridge,
    servers,
    get starts() {
      return state.starts;
    },
    opened,
  };
}

describe('the picker-owned web server', () => {
  it('starts exactly one server for two concurrent ^O presses', async () => {
    const web = fakeWeb();
    const opener = createTranscriptOpener(web.bridge, { port: 4777 });

    const [first, second] = await Promise.all([opener.openTranscript('s1', 3), opener.openTranscript('s2')]);

    expect(web.starts).toBe(1);
    expect(web.servers).toHaveLength(1);
    expect(first).toBe('http://127.0.0.1:4778/s/s1?m=3');
    expect(second).toBe('http://127.0.0.1:4778/s/s2');
  });

  it('closes the one it started, so the process can exit', async () => {
    const web = fakeWeb();
    const opener = createTranscriptOpener(web.bridge, { port: 4777 });
    await Promise.all([opener.openTranscript('s1'), opener.openTranscript('s2')]);

    await opener.close();

    expect(web.servers).toHaveLength(1);
    expect(web.servers[0]!.closed).toBe(1);
    // Closing twice must not throw or double-close.
    await opener.close();
    expect(web.servers[0]!.closed).toBe(1);
  });

  it('never lets its server embed: the picker is already doing that', async () => {
    const web = fakeWeb();
    const opener = createTranscriptOpener(web.bridge, { port: 4777 });
    await opener.openTranscript('s1');
    expect(web.servers[0]!.autoEmbed).toBe(false);
  });

  it('reuses a server that is already running instead of starting one', async () => {
    const web = fakeWeb({ running: 'http://127.0.0.1:4777' });
    const opener = createTranscriptOpener(web.bridge, { port: 4777 });
    const url = await opener.openTranscript('s1');
    expect(url).toBe('http://127.0.0.1:4777/s/s1');
    expect(web.starts).toBe(0);
    await opener.close();
  });

  it('does not remember a failed start, so the next ^O tries again', async () => {
    let attempt = 0;
    const bridge: WebBridge = {
      findRunningWeb: async () => null,
      startWebServer: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('port busy');
        return { url: 'http://127.0.0.1:4778', close: async () => undefined };
      },
      transcriptUrl: (handle, sessionId) => `${handle.url}/s/${sessionId}`,
      openInBrowser: () => true,
    };
    const opener = createTranscriptOpener(bridge, { port: 4777 });
    await expect(opener.openTranscript('s1')).rejects.toThrow('port busy');
    await expect(opener.openTranscript('s1')).resolves.toBe('http://127.0.0.1:4778/s/s1');
    await opener.close();
  });

  it('opens the browser at the URL it returns', async () => {
    const web = fakeWeb();
    const opener = createTranscriptOpener(web.bridge, { port: 4777 });
    const url = await opener.openTranscript('s1', 9);
    expect(web.opened).toEqual([url]);
    await opener.close();
  });
});

describe('leaving the picker', () => {
  it('exits with the code it was given once cleanup is done', async () => {
    const exits: number[] = [];
    await finishInteractive(42, async () => undefined, {
      exit: (code) => exits.push(code),
      flush: async () => undefined,
    });
    expect(exits).toEqual([42]);
  });

  it('exits anyway when cleanup never finishes', async () => {
    const exits: number[] = [];
    const started = Date.now();
    // Stands in for a model load inside native code: nothing can cancel it.
    const stuck = new Promise<void>(() => {});

    await finishInteractive(130, () => stuck, {
      graceMs: 50,
      exit: (code) => exits.push(code),
      flush: async () => undefined,
    });

    expect(exits).toEqual([130]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('exits even when cleanup throws', async () => {
    const exits: number[] = [];
    await finishInteractive(0, async () => {
      throw new Error('server already gone');
    }, { exit: (code) => exits.push(code), flush: async () => undefined });
    expect(exits).toEqual([0]);
  });

  it('gives cleanup a bounded, sub-second window', () => {
    expect(EXIT_GRACE_MS).toBeLessThanOrEqual(1000);
  });

  it('flushes stdout before leaving', async () => {
    const order: string[] = [];
    await finishInteractive(0, async () => {
      order.push('cleanup');
    }, {
      flush: async () => {
        order.push('flush');
      },
      exit: () => order.push('exit'),
    });
    expect(order).toEqual(['cleanup', 'flush', 'exit']);
  });
});

describe('openInBrowser', () => {
  it('never flashes a console window on Windows', async () => {
    vi.resetModules();
    const spawn = vi.fn(() => ({ on: () => undefined, unref: () => undefined }));
    vi.doMock('node:child_process', () => ({ spawn }));
    const { openInBrowser } = await import('../src/web/open.js');
    openInBrowser('http://127.0.0.1:4777/');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((spawn.mock.calls[0] as unknown[])[2]).toMatchObject({ windowsHide: true });
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });
});

import { spawn } from 'node:child_process';

/**
 * Opens a URL in the user's default browser, best effort. Never throws and
 * never keeps the process alive: failing to open a browser must not stop the
 * server from serving.
 */
export function openInBrowser(url: string): boolean {
  const command =
    process.platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : process.platform === 'win32'
        ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
        : { cmd: 'xdg-open', args: [url] };
  try {
    // `windowsHide` keeps `cmd /c start` from flashing a console window.
    const child = spawn(command.cmd, command.args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

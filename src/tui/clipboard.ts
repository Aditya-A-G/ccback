import { spawn } from 'node:child_process';

export interface ClipboardCommand {
  command: string;
  args: string[];
}

/** Clipboard writers tried in order; the first one that exists wins. */
export const CLIPBOARD_COMMANDS: ClipboardCommand[] = [
  { command: 'pbcopy', args: [] },
  { command: 'wl-copy', args: [] },
  { command: 'xclip', args: ['-selection', 'clipboard'] },
  { command: 'xsel', args: ['--clipboard', '--input'] },
  { command: 'clip.exe', args: [] },
];

/** Windows Terminal has no `pbcopy`; `clip` ships with Windows, PowerShell is the fallback. */
export const WINDOWS_CLIPBOARD_COMMANDS: ClipboardCommand[] = [
  { command: 'clip.exe', args: [] },
  { command: 'clip', args: [] },
  {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'],
  },
];

/** The writers worth trying on this platform, most likely first. */
export function clipboardCommands(platform: string = process.platform): ClipboardCommand[] {
  return platform === 'win32' ? WINDOWS_CLIPBOARD_COMMANDS : CLIPBOARD_COMMANDS;
}

/**
 * Writes `text` to the system clipboard. Resolves false when no clipboard tool
 * is installed, so the caller can fall back to printing the command on exit.
 * stdout/stderr of the helper are discarded: the terminal belongs to Ink.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const { command, args } of clipboardCommands()) {
    if (await tryCopy(command, args, text)) return true;
  }
  return false;
}

function tryCopy(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on('error', () => {
      finish(false);
    });
    child.on('close', (code) => {
      finish(code === 0);
    });
    child.stdin?.on('error', () => {
      finish(false);
    });
    try {
      child.stdin?.end(text);
    } catch {
      finish(false);
    }
  });
}

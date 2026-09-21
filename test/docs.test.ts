/**
 * The README is the behaviour contract, so it has to be true.
 *
 * It documented `Ctrl+S | start smart search`, a binding the picker
 * deliberately does not implement — a user pressing it got silence and no way
 * to tell whether it had worked. These tests fail when the key table lists a
 * binding the picker does not have, when it omits one the picker shows in its
 * footer, and when the flag lists in the README and `--help` drift apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aliasBlock, aliasLine, DEFAULT_ALIAS } from '../src/core/alias.js';
import { HELP, OPTION_TYPES } from '../src/cli.js';
import { footerHints } from '../src/tui/format.js';
import { classifyKey, type KeyFlags } from '../src/tui/keys.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');

/** The `| Key | Action |` table under "In the picker:". */
function keyTableRows(): { keys: string; action: string }[] {
  const rows: { keys: string; action: string }[] = [];
  for (const line of readme.split('\n')) {
    const match = /^\|([^|]+)\|([^|]+)\|\s*$/.exec(line);
    if (!match) continue;
    const keys = match[1]!.trim();
    if (keys === 'Key' || /^-+$/.test(keys)) continue;
    rows.push({ keys, action: match[2]!.trim() });
  }
  return rows;
}

/** Every `Ctrl+X` the README's key table claims. */
function documentedControlKeys(): Set<string> {
  const out = new Set<string>();
  for (const row of keyTableRows()) {
    for (const match of row.keys.matchAll(/Ctrl\+([A-Za-z])/g)) out.add(match[1]!.toLowerCase());
  }
  return out;
}

/** Every `^X` the picker can show in its footer, across every state. */
function footerControlKeys(): Set<string> {
  const out = new Set<string>();
  for (const expanded of [false, true]) {
    for (const sort of ['relevance', 'recent'] as const) {
      const hints = footerHints({
        expanded,
        hasMatches: true,
        hasPreview: true,
        hasQuery: true,
        hasCurrent: true,
        canOpenBrowser: true,
        sort,
      });
      for (const hint of hints) {
        for (const match of hint.text.matchAll(/\^([A-Za-z])/g)) out.add(match[1]!.toLowerCase());
      }
    }
  }
  return out;
}

const key = (over: Partial<KeyFlags> = {}): Partial<KeyFlags> => over;

describe('the README key table', () => {
  it('lists no binding the picker does not implement', () => {
    const missing = [...documentedControlKeys()].filter(
      (letter) => classifyKey(letter, key({ ctrl: true })) === null,
    );
    expect(missing).toEqual([]);
  });

  it('omits no binding the picker shows in its footer', () => {
    const documented = documentedControlKeys();
    const undocumented = [...footerControlKeys()].filter((letter) => !documented.has(letter));
    expect(undocumented).toEqual([]);
  });

  it('documents the keys that are not control keys', () => {
    const table = keyTableRows()
      .map((row) => row.keys)
      .join(' | ');
    expect(table).toContain('Enter');
    expect(table).toContain('Esc');
    expect(table).toContain('↑');
    expect(table).toContain('←');
    // Enter and Esc really are bound.
    expect(classifyKey('', key({ return: true }))).toEqual({ type: 'resume' });
    expect(classifyKey('', key({ escape: true }))).toEqual({ type: 'escape' });
  });

  it('says nothing about Ctrl+S, which does nothing', () => {
    expect(classifyKey('s', key({ ctrl: true }))).toBeNull();
    expect(documentedControlKeys().has('s')).toBe(false);
  });
});

/** `--flag` tokens in a block of text. */
function flagsIn(text: string): Set<string> {
  return new Set([...text.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]!));
}

/**
 * `--mode` is deliberately undocumented: it exists for debugging a ranking
 * question, not for anybody to have to choose between search strategies.
 */
const HIDDEN_FLAGS = new Set(['mode']);

/**
 * The README's option list — the fenced block holding `-w, --web`. Flags
 * elsewhere in the prose belong to other commands (`claude --resume`, `npm
 * install --omit=optional`) and are not ccfind's to document.
 */
function readmeOptionBlock(): string {
  const blocks = readme.split('```');
  const found = blocks.find((block) => block.includes('-w, --web'));
  if (found === undefined) throw new Error('README has no option list block');
  return found;
}

describe('the flags', () => {
  const helpFlags = flagsIn(HELP);
  const readmeFlags = flagsIn(readmeOptionBlock());

  it('are all flags the parser actually accepts', () => {
    for (const source of [helpFlags, readmeFlags]) {
      for (const flag of source) {
        expect(OPTION_TYPES, `--${flag}`).toHaveProperty(flag);
      }
    }
  });

  it('are documented in --help and in the README alike', () => {
    for (const flag of Object.keys(OPTION_TYPES)) {
      if (HIDDEN_FLAGS.has(flag)) continue;
      expect(helpFlags, `--${flag} missing from --help`).toContain(flag);
      expect(readmeFlags, `--${flag} missing from README`).toContain(flag);
    }
  });

  it('includes --yes, which used to be in neither', () => {
    expect(helpFlags).toContain('yes');
    expect(readmeFlags).toContain('yes');
  });

  it('keeps --mode out of both, on purpose', () => {
    expect(readme).not.toContain('--mode');
    expect(HELP).not.toContain('--mode');
  });
});

/**
 * The alias paragraph made three promises the code did not keep: that it always
 * asks first (`--yes` does not), that it appends "that one line and nothing
 * else" (it appends a blank line, a comment and the alias), and that a
 * non-terminal run never writes (it does, with `--yes`).
 */
describe('the README on --alias', () => {
  const paragraph = readme.split('\n').find((line) => line.includes('--alias')) ?? '';

  it('quotes the line the tool actually writes', () => {
    expect(paragraph).toContain(aliasLine(DEFAULT_ALIAS, 'zsh'));
    expect(aliasLine(DEFAULT_ALIAS, 'zsh')).toBe('alias sf=ccfind');
  });

  it('describes the whole block, not just the alias line', () => {
    // A blank line, a comment naming the tool, and the alias: three things.
    const block = aliasBlock(DEFAULT_ALIAS, 'zsh').split('\n');
    expect([block[0], block[1], block[2]]).toEqual(['', '# ccfind short command', 'alias sf=ccfind']);
    expect(paragraph).toContain('blank line');
    expect(paragraph).toContain('comment');
  });

  it('says what --yes does, and what happens with no terminal', () => {
    expect(paragraph).toContain('--yes');
    expect(paragraph.toLowerCase()).toContain('piped');
    // Every sentence that promises a question has to name the flag that skips
    // it: "asks first" on its own was the claim `--yes` made false.
    for (const sentence of paragraph.split('. ')) {
      if (!/\basks\b/.test(sentence)) continue;
      expect(sentence, sentence).toContain('--yes');
    }
  });
});

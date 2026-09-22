/**
 * The README is the behaviour contract, so it has to be true.
 *
 * A documented key the picker does not implement leaves the user pressing it
 * and getting silence, with no way to tell whether it worked; a key the picker
 * offers but the README omits is never found. These tests fail when the key
 * table lists a binding the picker does not have, when it omits one the picker
 * shows in its footer, and when the flag lists in the README and `--help`
 * drift apart.
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

/** The orders the picker cycles through, and the footer has to cover. */
const ORDERS = ['best', 'newest', 'oldest'] as const;

/** Every `^X` the picker can show in its footer, across every state. */
function footerControlKeys(): Set<string> {
  const out = new Set<string>();
  for (const expanded of [false, true]) {
    for (const order of ORDERS) {
      const hints = footerHints({
        expanded,
        hasMatches: true,
        hasPreview: true,
        hasQuery: true,
        hasCurrent: true,
        canOpenBrowser: true,
        order,
      });
      for (const hint of hints) {
        for (const match of hint.text.matchAll(/\^([A-Za-z])/g)) out.add(match[1]!.toLowerCase());
      }
    }
  }
  return out;
}

/**
 * Everything the README says about `--alias`, as one string: the paragraph
 * that introduces it and the bullets under it, up to the next heading.
 */
function aliasSection(): string {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line.includes('--alias'));
  if (start === -1) throw new Error('README says nothing about --alias');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('#'));
  return lines
    .slice(start, end === -1 ? undefined : end)
    .join(' ')
    .trim();
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

  it('describes Ctrl+R as the three-step cycle the footer offers', () => {
    const row = keyTableRows().find((entry) => entry.keys.includes('Ctrl+R'));
    expect(row, 'the README has no Ctrl+R row').toBeDefined();
    // The row names all three steps, in the order the key moves through them.
    const action = row!.action.toLowerCase();
    for (const word of ['best match', 'newest', 'oldest']) {
      expect(action, word).toContain(word);
    }
    expect(action.indexOf('newest')).toBeLessThan(action.indexOf('oldest'));

    // And those are exactly the three labels the footer can show.
    const labels = new Set<string>();
    for (const order of ORDERS) {
      for (const hint of footerHints({
        expanded: false,
        hasMatches: true,
        hasPreview: true,
        hasQuery: true,
        hasCurrent: true,
        canOpenBrowser: true,
        order,
      })) {
        if (hint.text.startsWith('^R ')) labels.add(hint.text);
      }
    }
    expect([...labels].sort()).toEqual(['^R best', '^R newest', '^R oldest']);
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
 * install --omit=optional`) and are not ccback's to document.
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

  it('documents --yes in both', () => {
    expect(helpFlags).toContain('yes');
    expect(readmeFlags).toContain('yes');
  });

  it('keeps --mode out of both, on purpose', () => {
    expect(readme).not.toContain('--mode');
    expect(HELP).not.toContain('--mode');
  });
});

/**
 * Every `SHOUTING_SNAKE` name the README mentions, with or without a `$`.
 *
 * The underscore is required: without it `PATH`, `README` and `BM25` come along
 * and none of them is a variable this tool reads.
 */
function envVarsIn(text: string): Set<string> {
  return new Set([...text.matchAll(/\$?\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)].map((match) => match[1]!));
}

/** Everything under `src/`, concatenated, so a name can be looked for in one string. */
function sourceText(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(projectRoot, 'src'));
  return out.join('\n');
}

/**
 * A variable the README names but nothing reads is a setting a user can spend
 * an afternoon on and never see take effect. A flag the README invents is
 * caught by the list above; an environment variable needs its own check.
 *
 * Only this direction is checked: `CCBACK_DEBUG` and `CCBACK_NO_MODEL` exist
 * on purpose without being documented.
 */
describe('the environment variables', () => {
  const src = sourceText();

  it('are all names something in src/ actually reads', () => {
    for (const name of envVarsIn(readme)) {
      expect(src, `${name} is in the README but nothing in src/ mentions it`).toContain(name);
    }
  });

  it('includes the ones the README leans on', () => {
    const documented = envVarsIn(readme);
    for (const name of ['CCBACK_HOME', 'CLAUDE_CONFIG_DIR', 'CCBACK_KEYWORD_ONLY']) {
      expect([...documented], name).toContain(name);
    }
  });
});

/** Rows an 80-column terminal spends on `text`, wrapping included. */
function screenRows(text: string, columns = 80): number {
  return text
    .split('\n')
    .slice(0, -1) // the trailing newline ends the last line; it is not a row
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 0);
}

/**
 * `--help` has to fit the screen it is printed on: past 24 lines, or wider than
 * 80 columns, the title and the examples have scrolled off before the reader
 * reaches the options.
 */
describe('--help', () => {
  it('fits one 24-line screen at 80 columns', () => {
    const lines = HELP.split('\n').slice(0, -1);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(80);
    expect(screenRows(HELP)).toBeLessThanOrEqual(24);
  });

  it('describes the recency tilt, in the README and in --help alike', () => {
    // One honest sentence: fit first, recency as the tie-breaker — not a claim
    // that the newest session wins.
    const sentence = 'Best match ranks by how well a session fits your words and meaning,';
    expect(readme).toContain(sentence);
    expect(readme).toContain('small preference for recent activity when it is close');
    expect(HELP).toContain('Best match ranks by words and meaning, preferring recent activity');
  });

  it('documents the same three --sort values in both', () => {
    for (const [name, text] of [
      ['--help', HELP],
      ['README', readme],
    ] as const) {
      expect(text, name).toContain('--sort best|recent|oldest');
    }
    // `relevance` still works, and stays undocumented.
    expect(readme).not.toContain('--sort relevance');
    expect(HELP).not.toContain('relevance');
  });

  it('agrees with the README that --port 0 takes any free port', () => {
    for (const [name, text] of [
      ['--help', HELP],
      ['README', readme],
    ] as const) {
      expect(text, name).toContain('--port 0');
      expect(text, name).toContain('free port');
    }
  });
});

describe('CHANGELOG.md', () => {
  const changelog = fs.readFileSync(path.join(projectRoot, 'CHANGELOG.md'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
    version: string;
  };

  it('has an entry for the version being published', () => {
    expect(changelog).toContain(`## ${pkg.version}`);
  });

  it('describes the release in a handful of plain bullets', () => {
    const bullets = changelog.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets.length).toBeGreaterThanOrEqual(3);
    expect(bullets.length).toBeLessThanOrEqual(6);
  });
});

/**
 * Windows and Linux are only ever exercised in CI, so the workflow that does it
 * is part of the contract: drop a platform and the suite stops being honest.
 */
describe('the CI workflow', () => {
  const workflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('runs every platform and node version, and does not stop at the first failure', () => {
    for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
      expect(workflow, os).toContain(os);
    }
    expect(workflow).toContain('node: [22, 24]');
    expect(workflow).toContain('fail-fast: false');
  });

  it('runs build, typecheck and the tests without downloading a model', () => {
    for (const step of ['npm ci', 'npm run build', 'npm run typecheck', 'npm test']) {
      expect(workflow, step).toContain(step);
    }
    expect(workflow).toContain('CCBACK_NO_MODEL');
  });

  it('asks for read access only, uses pinned official actions, and needs no secrets', () => {
    expect(workflow).toContain('permissions:');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('actions/checkout@v4');
    expect(workflow).toContain('actions/setup-node@v4');
    expect(workflow).not.toContain('secrets.');
    // Only the two official actions, both pinned to a major version.
    for (const used of workflow.matchAll(/uses:\s*(\S+)/g)) {
      expect(['actions/checkout@v4', 'actions/setup-node@v4']).toContain(used[1]);
    }
  });
});

/**
 * `--alias` is the one command that writes to a file the user owns, so the
 * README has to describe it exactly: the whole block that gets appended, not
 * just the alias line; that `--yes` skips the question; and that a run with no
 * terminal still writes when `--yes` is passed.
 */
describe('the README on --alias', () => {
  const paragraph = aliasSection();

  it('quotes the line the tool actually writes', () => {
    expect(paragraph).toContain(aliasLine(DEFAULT_ALIAS, 'zsh'));
    expect(aliasLine(DEFAULT_ALIAS, 'zsh')).toBe('alias sf=ccback');
  });

  it('describes the whole block, not just the alias line', () => {
    // A blank line, a comment naming the tool, and the alias: three things.
    const block = aliasBlock(DEFAULT_ALIAS, 'zsh').split('\n');
    expect([block[0], block[1], block[2]]).toEqual(['', '# ccback short command', 'alias sf=ccback']);
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

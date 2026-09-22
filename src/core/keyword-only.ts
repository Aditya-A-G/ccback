/**
 * Keyword-only: the one switch that takes the embedding half of the tool out
 * of the picture entirely.
 *
 * `--mode keyword` only changes how a search is ranked; this is a different
 * promise. When it is on, nothing in any front end loads transformers,
 * downloads a model or embeds a chunk — not the picker's background setup, not
 * the browser UI's, not `--reindex`. Embeddings already on disk are left
 * exactly where they are, so turning it off again carries on where it stopped.
 *
 * It is asked for with `--keyword-only` for one run, or with
 * `CCBACK_KEYWORD_ONLY` in the environment for every run.
 */
import { UserError } from './errors.js';
import { APP_NAME } from './paths.js';

/** Environment variable that makes keyword-only permanent. */
export const KEYWORD_ONLY_ENV = 'CCBACK_KEYWORD_ONLY';

/**
 * Which switch asked for keyword-only. Null means smart search is on.
 *
 * The exact spelling is what `--stats` prints, so somebody who does not
 * remember exporting the variable can see which of the two it was.
 */
export type KeywordOnlySource = '--keyword-only' | typeof KEYWORD_ONLY_ENV;

const YES: ReadonlySet<string> = new Set(['1', 'true', 'yes']);
const NO: ReadonlySet<string> = new Set(['0', 'false', 'no', '']);

/**
 * Reads the environment variable, case-insensitively.
 *
 * Unset, empty, `0`, `false` and `no` are off. Anything that is neither a yes
 * nor a no is a mistake worth one line: silently searching the wrong way
 * because `CCBACK_KEYWORD_ONLY=ture` is not a thing anybody would notice.
 */
export function keywordOnlyFromEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (YES.has(normalized)) return true;
  if (NO.has(normalized)) return false;
  throw new UserError(
    `${KEYWORD_ONLY_ENV} must be 1, true or yes to turn smart search off, or 0, false or no to leave it on; ` +
      `got ${JSON.stringify(value)}.`,
  );
}

/**
 * Whether this run is keyword-only, and which switch said so. The flag wins the
 * naming, but the variable is read either way so a bad value is still reported.
 */
export function resolveKeywordOnly(
  flag: boolean,
  env: NodeJS.ProcessEnv = process.env,
): KeywordOnlySource | null {
  const fromEnv = keywordOnlyFromEnv(env[KEYWORD_ONLY_ENV]);
  if (flag) return '--keyword-only';
  return fromEnv ? KEYWORD_ONLY_ENV : null;
}

/** One line: smart search is off, and what to do to get it back. */
export function keywordOnlyNotice(source: KeywordOnlySource): string {
  return source === '--keyword-only'
    ? `Smart search is disabled by --keyword-only; run ${APP_NAME} without it to turn it back on.`
    : `Smart search is disabled by ${KEYWORD_ONLY_ENV}; unset it (or set it to 0) to turn it back on.`;
}

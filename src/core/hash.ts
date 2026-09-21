import { createHash } from 'node:crypto';

/**
 * Digest stored in `chunks.text_hash`.
 *
 * It is the whole point of incremental embedding: when a session is re-indexed
 * the new chunks are hashed and every chunk whose hash is unchanged keeps the
 * vector the old row had, so a day of conversation only costs the embedding of
 * the sentences that are actually new.
 *
 * SHA-256 truncated to 128 bits: collisions are not a realistic worry, and the
 * short form keeps the column small over ~13k chunks.
 */
export function chunkHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openingFromPgn } from '../src/content/pgnTree';
import type { Opening } from '../src/engine/types';

export const OPENINGS_DIR = join(__dirname, '..', 'content', 'openings');

export function contentFiles(): { id: string; text: string }[] {
  return readdirSync(OPENINGS_DIR)
    .filter((f) => f.endsWith('.pgn'))
    .map((f) => ({ id: f.replace(/\.pgn$/, ''), text: readFileSync(join(OPENINGS_DIR, f), 'utf8') }));
}

export function opening(pgn: string, side: 'white' | 'black' = 'white', id = 'test'): Opening {
  const { opening, errors } = openingFromPgn(pgn, { id, source: 'imported', side });
  if (errors.length) throw new Error(errors.join('; '));
  return opening;
}

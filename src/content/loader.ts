import { openingFromPgn } from './pgnTree';
import type { Opening } from '../engine/types';

// Bundled at build time; available offline through the PWA precache.
const files = import.meta.glob('/content/openings/*.pgn', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

let cache: Opening[] | null = null;

export function loadBuiltinOpenings(): Opening[] {
  if (cache) return cache;
  const out: Opening[] = [];
  for (const [path, text] of Object.entries(files)) {
    const id = path.split('/').pop()!.replace(/\.pgn$/, '');
    const { opening, errors } = openingFromPgn(text, { id, source: 'builtin' });
    if (errors.length) console.error(`Content errors in ${id}:`, errors);
    out.push(opening);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  cache = out;
  return out;
}

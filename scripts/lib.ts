// Shared helpers for the content scripts (run with tsx, not bundled into the app).
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { openingFromPgn, stripAnnotations } from '../src/content/pgnTree';
import { posKey } from '../src/engine/fen';
import { enumerateLines, formatMove } from '../src/engine/tree';
import type { Line, Opening } from '../src/engine/types';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OPENINGS_DIR = join(ROOT, 'content', 'openings');
export const LICHESS_DIR = join(ROOT, 'content', 'lichess');

export interface ContentOpening {
  file: string;
  opening: Opening;
  lines: Line[];
  errors: string[];
}

export function loadContent(): ContentOpening[] {
  return readdirSync(OPENINGS_DIR)
    .filter((f) => f.endsWith('.pgn'))
    .sort()
    .map((file) => {
      const text = readFileSync(join(OPENINGS_DIR, file), 'utf8');
      const { opening, errors } = openingFromPgn(text, { id: file.replace(/\.pgn$/, ''), source: 'builtin' });
      return { file, opening, lines: enumerateLines(opening), errors };
    });
}

export interface EcoEntry {
  eco: string;
  name: string;
  pgn: string;
  plies: number;
}

/** posKey -> dataset entry (the dataset has one entry per named position). */
export function loadLichess(): Map<string, EcoEntry> {
  const map = new Map<string, EcoEntry>();
  for (const f of ['a', 'b', 'c', 'd', 'e']) {
    const rows = readFileSync(join(LICHESS_DIR, `${f}.tsv`), 'utf8').split(/\r?\n/).slice(1);
    for (const row of rows) {
      if (!row.trim()) continue;
      const [eco, name, pgn] = row.split('\t');
      const chess = new Chess();
      const sans = pgn.replace(/\d+\.(\.\.)?/g, ' ').split(/\s+/).filter(Boolean);
      try {
        for (const s of sans) chess.move(s);
      } catch {
        continue;
      }
      const key = posKey(chess.fen());
      const prev = map.get(key);
      // keep the shortest move order for a position (the canonical one)
      if (!prev || sans.length < prev.plies) map.set(key, { eco, name, pgn, plies: sans.length });
    }
  }
  return map;
}

export interface LineClassification {
  matches: { ply: number; entry: EcoEntry }[];
  deepest?: EcoEntry;
  deepestPly?: number;
}

export function classifyLine(line: Line, rootFen: string, eco: Map<string, EcoEntry>): LineClassification {
  const matches: { ply: number; entry: EcoEntry }[] = [];
  const root = eco.get(posKey(rootFen));
  if (root) matches.push({ ply: 0, entry: root });
  line.nodes.forEach((n, i) => {
    const e = eco.get(posKey(n.fen));
    if (e) matches.push({ ply: i + 1, entry: e });
  });
  const last = matches[matches.length - 1];
  return { matches, deepest: last?.entry, deepestPly: last?.ply };
}

export function moveText(line: Line, rootFen: string): string {
  return line.nodes.map((n, i) => {
    const parent = i === 0 ? rootFen : line.nodes[i - 1].fen;
    const label = formatMove(parent, n.san);
    // only show the move number before White moves and the first move
    return i === 0 || parent.split(' ')[1] === 'w' ? label : n.san;
  }).join(' ');
}

export function lineComments(line: Line, rootFen: string): { move: string; text: string }[] {
  return line.nodes.flatMap((n, i) => {
    const text = n.comment ? stripAnnotations(n.comment) : '';
    if (!text) return [];
    const parent = i === 0 ? rootFen : line.nodes[i - 1].fen;
    return [{ move: formatMove(parent, n.san), text }];
  });
}

export function normName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/defence/g, 'defense').replace(/['’]/g, "'").trim();
}

export function family(name: string): string {
  return normName(name.split(':')[0]);
}

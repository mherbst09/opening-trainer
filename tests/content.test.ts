import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { parsePgn, type ChildNode, type PgnNodeData } from 'chessops/pgn';
import { openingFromPgn, parseSide } from '../src/content/pgnTree';
import { enumerateLines, indexOpening } from '../src/engine/tree';
import { buildCards } from '../src/engine/cards';
import { contentFiles } from './helpers';

const files = contentFiles();

describe('built-in content', () => {
  it('has at least one opening', () => expect(files.length).toBeGreaterThan(0));

  for (const { id, text } of files) {
    describe(id, () => {
      it('every move in every variation is legal (chess.js)', () => {
        const [game] = parsePgn(text);
        const illegal: string[] = [];
        const walk = (fen: string, nodes: ChildNode<PgnNodeData>[], path: string[]) => {
          for (const n of nodes) {
            const c = new Chess(fen);
            try {
              c.move(n.data.san);
            } catch {
              illegal.push([...path, n.data.san].join(' '));
              continue;
            }
            walk(c.fen(), n.children, [...path, n.data.san]);
          }
        };
        walk(new Chess().fen(), game.moves.children, []);
        expect(illegal).toEqual([]);
      });

      it('has required headers and parses without errors', () => {
        const { opening, errors } = openingFromPgn(text, { id, source: 'builtin' });
        expect(errors).toEqual([]);
        const [game] = parsePgn(text);
        expect(game.headers.get('Opening')).toBeTruthy();
        expect(game.headers.get('ECO')).toMatch(/^[A-E]\d\d$/);
        expect(parseSide(game.headers.get('Side'))).toBeDefined();
        expect(['1', '2', '3']).toContain(game.headers.get('Difficulty'));
        expect(opening.tags.length).toBeGreaterThan(0);
      });

      it('lines are 6-16 full moves and have comments', () => {
        const { opening } = openingFromPgn(text, { id, source: 'builtin' });
        for (const line of enumerateLines(opening)) {
          const fullMoves = Math.ceil(line.nodes.length / 2);
          expect(fullMoves, line.name).toBeGreaterThanOrEqual(6);
          expect(fullMoves, line.name).toBeLessThanOrEqual(16);
          expect(line.nodes.some((n) => n.comment), line.name).toBe(true);
        }
      });

      it('produces cards for the learner side', () => {
        const { opening } = openingFromPgn(text, { id, source: 'builtin' });
        expect(buildCards(indexOpening(opening)).length).toBeGreaterThan(3);
      });
    });
  }
});

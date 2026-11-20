import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { parsePgn } from 'chessops/pgn';
import { DefaultScheduler, Rating } from 'ts-fsrs';

describe('dependency smoke test', () => {
  it('chess.js plays moves', () => {
    const c = new Chess();
    c.move('e4');
    expect(c.turn()).toBe('b');
  });
  it('chessops keeps variations and comments', () => {
    const [game] = parsePgn('1. e4 { King pawn } e5 (1... c5 { Sicilian }) 2. Nf3 *');
    const e4 = game.moves.children[0];
    expect(e4.data.comments?.[0]).toBe('King pawn');
    expect(e4.children.map((c) => c.data.san)).toEqual(['e5', 'c5']);
  });
  it('ts-fsrs schedules a card', async () => {
    const s = await DefaultScheduler();
    const now = new Date('2026-11-20T10:00:00Z');
    const r = s.review({ card: s.newCard({ now }), grade: Rating.Good, now });
    expect(r.card.dueAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

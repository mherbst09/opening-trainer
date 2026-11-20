import { describe, it, expect } from 'vitest';
import { indexOpening } from '../src/engine/tree';
import { buildCards } from '../src/engine/cards';
import { reviewSrs } from '../src/engine/scheduler';
import type { QuizContext, Outcome } from '../src/engine/quiz';
import {
  dueLineQueue, lineCardIds, linePlayMove, lineReveal, lineUseHint, nextLine, opponentStep,
  startLineQuiz, summarizeLines, type LineQuizState,
} from '../src/engine/lineQuiz';
import { opening } from './helpers';

// Two lines for white; black's 3...Nf6 branch; 4.d3 vs 4.c3 alternatives at move 4.
const PGN = `1. e4 e5 2. Nf3 Nc6 3. Bc4 { Eyes f7. } Bc5 (3... Nf6 4. d3 Be7) 4. c3 (4. d3 Nf6) 4... Nf6 5. d4 *`;
// White learner; after 1.d4 Nf6 2.c4 e6 3.Nf3 the same position arises via 2.Nf3 e6 3.c4.
const TRANS = `1. d4 Nf6 2. c4 (2. Nf3 e6 3. c4 d5) 2... e6 3. Nf3 b6 4. g3 *`;

function ctx(pgn: string, side: 'white' | 'black') {
  const o = opening(pgn, side, 'o');
  const index = indexOpening(o);
  const cards = buildCards(index);
  const c: QuizContext = {
    cards: new Map(cards.map((x) => [x.id, x])),
    indexes: new Map([[o.id, index]]),
    requeueLapses: false,
    rng: () => 0,
  };
  return { c, index, cards };
}

/** Play learner moves (with opponent replies) and collect outcomes. */
function play(s: LineQuizState, c: QuizContext, moves: string[], stop = false) {
  const outcomes: Outcome[] = [];
  for (const m of moves) {
    const r = linePlayMove(s, c, { stopAtFirstMistake: stop }, m);
    if (r.outcome) outcomes.push(r.outcome);
    s = r.state;
    if (s.phase === 'opponent') s = opponentStep(s, c);
  }
  return { s, outcomes };
}

describe('full line recall', () => {
  it('perfect line grades every learner position Good and ends the line', () => {
    const { c, index } = ctx(PGN, 'white');
    const main = index.lines[0];
    expect(main.nodes.map((n) => n.san).join(' ')).toBe('e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4');
    const { s, outcomes } = play(startLineQuiz(c, [main.id]), c, ['e2e4', 'g1f3', 'f1c4', 'c2c3', 'd2d4']);
    expect(s.phase).toBe('line-done');
    expect(outcomes.map((o) => o.grade)).toEqual([3, 3, 3, 3, 3]);
    expect(new Set(outcomes.map((o) => o.cardId))).toEqual(new Set(lineCardIds(c, main)));
    expect(summarizeLines(s.results)).toMatchObject({ lines: 1, perfect: 1, moves: 5, correct: 5, accuracy: 1 });
    expect(nextLine(s, c).phase).toBe('done');
  });

  it('as black, the opponent first move is played automatically', () => {
    const { c, index } = ctx(PGN, 'black');
    const s = startLineQuiz(c, [index.lines[0].id]);
    expect(s.phase).toBe('awaiting');
    expect(s.ply).toBe(1);
    expect(s.lastMove).toEqual(['e2', 'e4']);
    const { s: end, outcomes } = play(s, c, ['e7e5', 'b8c6', 'f8c5', 'g8f6']);
    expect(end.phase).toBe('line-done');
    expect(outcomes).toHaveLength(4);
  });

  it('stop at first mistake: line ends, only that position is a lapse', () => {
    const { c, index } = ctx(PGN, 'white');
    const { s, outcomes } = play(startLineQuiz(c, [index.lines[0].id]), c, ['e2e4', 'b1c3'], true);
    expect(s.phase).toBe('line-done');
    expect(s.results[0].stopped).toBe(true);
    expect(outcomes.map((o) => o.grade)).toEqual([3, 1]);
    expect(s.results[0].plies[1]).toMatchObject({ mark: 'mistake', expected: { san: 'Nf3' }, played: 'b1c3', playedSan: 'Nc3' });
  });

  it('continue after mistake: must play the book move (or reveal), line is flagged', () => {
    const { c, index } = ctx(PGN, 'white');
    let { s, outcomes } = play(startLineQuiz(c, [index.lines[0].id]), c, ['e2e4', 'b1c3']);
    expect(s.phase).toBe('mistake');
    // another wrong move does not grade again
    let r = linePlayMove(s, c, { stopAtFirstMistake: false }, 'd2d4');
    expect(r.outcome).toBeUndefined();
    expect(r.state.phase).toBe('mistake');
    s = opponentStep(lineReveal(r.state, c), c);
    expect(s.phase).toBe('awaiting');
    const rest = play(s, c, ['f1c4', 'c2c3', 'd2d4']);
    outcomes = [...outcomes, ...rest.outcomes];
    expect(outcomes.map((o) => o.grade)).toEqual([3, 1, 3, 3, 3]);
    const sum = summarizeLines(rest.s.results);
    expect(sum).toMatchObject({ perfect: 0, stopped: 0, moves: 5, correct: 4 });
  });

  it('hint grades Hard', () => {
    const { c, index } = ctx(PGN, 'white');
    const s = lineUseHint(startLineQuiz(c, [index.lines[0].id]));
    expect(linePlayMove(s, c, { stopAtFirstMistake: false }, 'e2e4').outcome?.grade).toBe(2);
  });

  it('alternative book move switches to that branch', () => {
    const { c, index } = ctx(PGN, 'white');
    const main = index.lines[0];
    const { s } = play(startLineQuiz(c, [main.id]), c, ['e2e4', 'g1f3', 'f1c4', 'd2d3']);
    expect(s.note).toContain('also book');
    expect(s.lineId).not.toBe(main.id);
    expect(s.phase).toBe('line-done'); // 4.d3 Nf6 is the end of that branch
    expect(s.results[0].plies[3].mark).toBe('alternative');
    expect(s.results[0].lineId).toBe(s.lineId);
  });

  it('transposed book move is accepted but the line continues as written', () => {
    const { c, index } = ctx(TRANS, 'white');
    const viaNf3 = index.lines.find((l) => l.nodes[2].san === 'Nf3')!;
    // In the 2.Nf3 line, after 2...e6 the book move is 3.c4; nothing else is book there.
    const start = play(startLineQuiz(c, [viaNf3.id]), c, ['d2d4', 'g1f3']).s;
    expect(start.phase).toBe('awaiting');
    const r = linePlayMove(start, c, { stopAtFirstMistake: false }, 'c2c4');
    expect(r.outcome?.grade).toBe(3);
  });

  it('due line queue: overdue lines first, then lines with new cards within the budget', async () => {
    const { c, index } = ctx(PGN, 'white');
    const now = Date.UTC(2026, 10, 20);
    // lines: [main 4.c3, 4.d3 (same move-4 position as 4.c3), 3...Nf6 4.d3]
    const [a, d3, nf6] = index.lines;
    expect(nf6.nodes[5].san).toBe('Nf6');
    // every position of the main line reviewed long ago -> overdue
    const srs = await reviewSrs(undefined, 3, now - 40 * 86_400_000);
    for (const id of lineCardIds(c, a)) c.cards.set(id, { ...c.cards.get(id)!, srs });
    // main line covers all due positions; 4.d3 line adds nothing new; 3...Nf6 has a new position
    expect(dueLineQueue(c, index.lines, now, 20)).toEqual([a.id, nf6.id]);
    expect(dueLineQueue(c, index.lines, now, 20)).not.toContain(d3.id);
    expect(dueLineQueue(c, index.lines, now, 0)).toEqual([a.id]);
  });
});

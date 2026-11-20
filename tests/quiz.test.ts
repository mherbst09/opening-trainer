import { describe, it, expect } from 'vitest';
import { indexOpening } from '../src/engine/tree';
import { buildCards } from '../src/engine/cards';
import { gradeAnswer, reviewSrs, cardStatus } from '../src/engine/scheduler';
import {
  advance, currentCard, dueQueue, hintSquare, playMove, practiceQueue, reveal, skip,
  startNextMove, summarize, useHint, type QuizContext,
} from '../src/engine/quiz';
import { opening } from './helpers';

const PGN = `1. e4 e5 2. Nf3 Nc6 3. Bc4 { Eyes f7. } Bc5 (3... Nf6 4. d3) 4. c3 Nf6 5. d4 *`;

function ctx(side: 'white' | 'black' = 'white') {
  const o = opening(PGN, side, 'it');
  const index = indexOpening(o);
  const cards = buildCards(index);
  const c: QuizContext = {
    cards: new Map(cards.map((x) => [x.id, x])),
    indexes: new Map([[o.id, index]]),
    requeueLapses: true,
    rng: () => 0,
  };
  return { c, cards };
}

const DAY = 86_400_000;

describe('grading', () => {
  const base = { correct: true, wrongAttempts: 0, hintUsed: false, revealed: false, ms: 5000 };
  it('maps answers to FSRS grades', () => {
    expect(gradeAnswer(base)).toBe(3);
    expect(gradeAnswer({ ...base, hintUsed: true })).toBe(2);
    expect(gradeAnswer({ ...base, wrongAttempts: 1 })).toBe(1);
    expect(gradeAnswer({ ...base, revealed: true, correct: false })).toBe(1);
  });
  it('gives Easy only for fast answers on mature cards', async () => {
    const now = Date.UTC(2026, 10, 20);
    let srs = await reviewSrs(undefined, 3, now);
    for (let i = 0; i < 4; i++) srs = await reviewSrs(srs, 3, srs.dueAt);
    expect(srs.stability).toBeGreaterThan(7);
    expect(gradeAnswer({ ...base, ms: 1000, srs })).toBe(4);
    expect(gradeAnswer({ ...base, ms: 1000 })).toBe(3);
  });
});

describe('FSRS updates', () => {
  it('Good pushes due date out, Again keeps it close and counts a lapse', async () => {
    const now = Date.UTC(2026, 10, 20);
    const good = await reviewSrs(undefined, 3, now);
    expect(good.dueAt).toBeGreaterThan(now + DAY);
    expect(good.reps).toBe(1);
    const again = await reviewSrs(good, 1, good.dueAt);
    expect(again.lapses).toBe(1);
    expect(again.dueAt - good.dueAt).toBeLessThan(DAY);
    // round-trips through JSON (as stored in IndexedDB / the sync file)
    const json = JSON.parse(JSON.stringify(again));
    await expect(reviewSrs(json, 3, again.dueAt)).resolves.toMatchObject({ reps: 3 });
  });
  it('card status', async () => {
    const now = Date.UTC(2026, 10, 20);
    const { cards } = ctx();
    expect(cardStatus(cards[0], now)).toBe('new');
    const srs = await reviewSrs(undefined, 3, now);
    expect(cardStatus({ ...cards[0], srs }, now)).toBe('learning');
    expect(cardStatus({ ...cards[0], srs }, srs.dueAt)).toBe('due');
  });
});

describe('next-move quiz', () => {
  it('correct answer -> opponent replies -> continuation card follows', () => {
    const { c, cards } = ctx();
    // queue deliberately out of order: the continuation is pulled forward
    let s = startNextMove(c, [cards[0].id, cards[3].id, cards[2].id, cards[1].id], 0);
    const r = playMove(s, c, 'e2e4', 1000);
    expect(r.outcome).toEqual({ cardId: cards[0].id, grade: 3 });
    s = advance(r.state, c, 1000);
    expect(currentCard(s, c)?.id).toBe(cards[1].id);
    expect(s.lastMove).toEqual(['e7', 'e5']);
  });

  it('shows the comment after answering', () => {
    const { c, cards } = ctx();
    const s = startNextMove(c, [cards[2].id], 0);
    expect(playMove(s, c, 'f1c4', 10).state.comment).toBe('Eyes f7.');
  });

  it('wrong move -> retry grades Again; the lapse is requeued once', () => {
    const { c, cards } = ctx();
    let s = startNextMove(c, [cards[0].id], 0);
    s = playMove(s, c, 'd2d4', 10).state;
    expect(s.phase).toBe('wrong');
    const r = playMove(s, c, 'e2e4', 20);
    expect(r.outcome?.grade).toBe(1);
    s = advance(r.state, c, 30);
    expect(currentCard(s, c)?.id).toBe(cards[0].id);
    s = advance(playMove(s, c, 'd2d4', 40).state, c, 50); // wrong but not answered -> no advance
    expect(s.phase).toBe('wrong');
    s = advance(playMove(s, c, 'e2e4', 60).state, c, 70);
    expect(s.phase).toBe('done');
  });

  it('hint -> Hard, reveal -> Again, skip -> no grade', () => {
    const { c, cards } = ctx();
    let s = startNextMove(c, cards.map((x) => x.id), 0);
    expect(hintSquare(s, c)).toBe('e2');
    s = useHint(s);
    const r1 = playMove(s, c, 'e2e4', 1);
    expect(r1.outcome?.grade).toBe(2);
    s = advance(r1.state, c, 2);
    const r2 = reveal(s, c, 3);
    expect(r2.outcome?.grade).toBe(1);
    expect(r2.state.played?.san).toBe('Nf3');
    s = advance(r2.state, c, 4);
    s = skip(s, c, 5);
    expect(summarize(s.results)).toMatchObject({ reviewed: 2, skipped: 1, correct: 1 });
  });

  it('accepts alternative book moves for black (3...Bc5 and 3...Nf6)', () => {
    const { c, cards } = ctx('black');
    const card = cards.find((x) => x.accepted.length === 2)!;
    expect(card.accepted.map((m) => m.san).sort()).toEqual(['Bc5', 'Nf6']);
    const s = startNextMove(c, [card.id], 0);
    expect(playMove(s, c, 'g8f6', 1).outcome?.grade).toBe(3);
  });

  it('queues: due first by date, new cards capped; practice = all', async () => {
    const { cards } = ctx();
    const now = Date.UTC(2026, 10, 20);
    const srs = await reviewSrs(undefined, 3, now - 30 * DAY);
    const withProgress = cards.map((x, i) => (i === 3 ? { ...x, srs } : x));
    expect(dueQueue(withProgress, now, 2)).toEqual([cards[3].id, cards[0].id, cards[1].id]);
    expect(practiceQueue(withProgress)).toHaveLength(cards.length);
  });
});

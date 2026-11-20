import { describe, it, expect } from 'vitest';
import { shouldRecord } from '../src/engine/recordPolicy';
import { reviewSrs } from '../src/engine/scheduler';
import type { Card } from '../src/engine/types';

const now = Date.UTC(2026, 10, 20, 12);
const base: Card = { id: 'o|x', openingId: 'o', posKey: 'x', fen: '', accepted: [], lineIds: [] };

describe('record policy', async () => {
  const learning = { ...base, srs: await reviewSrs(undefined, 3, now - 60_000) }; // reviewed, not due
  const overdue = { ...base, srs: await reviewSrs(undefined, 3, now - 60 * 86_400_000) };
  const p = { now, countPracticeReviews: false, oncePerSession: false };

  it('due sessions record everything', () => {
    expect(shouldRecord({ ...p, card: learning, grade: 3, queue: 'due' })).toBe(true);
  });
  it('practice records new and due cards, skips correct answers on not-yet-due cards', () => {
    expect(shouldRecord({ ...p, card: base, grade: 3, queue: 'all' })).toBe(true);
    expect(shouldRecord({ ...p, card: overdue, grade: 3, queue: 'all' })).toBe(true);
    expect(shouldRecord({ ...p, card: learning, grade: 3, queue: 'all' })).toBe(false);
    expect(shouldRecord({ ...p, card: learning, grade: 2, queue: 'all' })).toBe(false);
  });
  it('practice always records a lapse', () => {
    expect(shouldRecord({ ...p, card: learning, grade: 1, queue: 'all' })).toBe(true);
  });
  it('countPracticeReviews records everything', () => {
    expect(shouldRecord({ ...p, countPracticeReviews: true, card: learning, grade: 3, queue: 'all' })).toBe(true);
  });
  it('once per session: only a first lapse after an earlier grade', () => {
    const q = { ...p, oncePerSession: true, card: overdue, queue: 'due' as const };
    expect(shouldRecord({ ...q, grade: 3 })).toBe(true);
    expect(shouldRecord({ ...q, grade: 3, previous: 3 })).toBe(false);
    expect(shouldRecord({ ...q, grade: 1, previous: 3 })).toBe(true);
    expect(shouldRecord({ ...q, grade: 1, previous: 1 })).toBe(false);
  });
});

import { cardStatus, type Grade } from './scheduler';
import type { Card } from './types';

export interface RecordPolicyInput {
  card: Card;
  grade: Grade;
  now: number;
  queue: 'due' | 'all';
  countPracticeReviews: boolean;
  /** grade already recorded for this card earlier in the session */
  previous?: Grade;
  /** full-line mode: lines share opening moves, so grade each position once per session */
  oncePerSession: boolean;
}

/**
 * Decide whether an answer updates FSRS.
 * - Due sessions record everything.
 * - Practice sessions record new and due cards, and always record a lapse (Again):
 *   forgetting is real information. Correct answers on cards that are not due yet are
 *   ignored so practising does not inflate intervals (unless countPracticeReviews).
 * - With oncePerSession, a position is graded at most once, except a first lapse.
 */
export function shouldRecord(i: RecordPolicyInput): boolean {
  if (i.oncePerSession && i.previous !== undefined) return i.grade === 1 && i.previous !== 1;
  if (i.queue === 'due' || i.countPracticeReviews || i.grade === 1) return true;
  const status = cardStatus(i.card, i.now);
  return status === 'new' || status === 'due';
}

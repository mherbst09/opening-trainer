import { DefaultScheduler, State, type Grade as FsrsGrade } from 'ts-fsrs';
import type { Card, SrsState } from './types';

export type Grade = 1 | 2 | 3 | 4;
export const GRADE_NAME: Record<Grade, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

type Scheduler = Awaited<ReturnType<typeof DefaultScheduler>>;
let schedulerPromise: Promise<Scheduler> | null = null;
export function getScheduler(): Promise<Scheduler> {
  schedulerPromise ??= DefaultScheduler();
  return schedulerPromise;
}

export interface AnswerFacts {
  correct: boolean; // eventually played an accepted move without reveal
  wrongAttempts: number;
  hintUsed: boolean;
  revealed: boolean;
  ms: number; // time to first correct answer
  srs?: SrsState;
}

/** Automatic grading of one answer. */
export function gradeAnswer(f: AnswerFacts): Grade {
  if (f.revealed || !f.correct || f.wrongAttempts > 0) return 1;
  if (f.hintUsed) return 2;
  const mature = f.srs && f.srs.state === State.Review && f.srs.stability >= 7;
  if (mature && f.ms < 3000) return 4;
  return 3;
}

function toSched(s: SrsState) {
  return {
    ...s,
    dueAt: new Date(s.dueAt),
    lastReviewAt: s.lastReviewAt == null ? null : new Date(s.lastReviewAt),
  };
}

function fromSched(c: Record<string, unknown>): SrsState {
  return {
    stability: c.stability as number,
    stabilityFast: c.stabilityFast as number,
    difficulty: c.difficulty as number,
    state: c.state as number,
    scheduleStatus: String(c.scheduleStatus),
    dueAt: (c.dueAt as Date).getTime(),
    lastReviewAt: c.lastReviewAt ? (c.lastReviewAt as Date).getTime() : null,
    reps: c.reps as number,
    lapses: c.lapses as number,
    scheduledDays: c.scheduledDays as number,
    learningStep: c.learningStep as number,
  };
}

export async function reviewSrs(srs: SrsState | undefined, grade: Grade, now: number): Promise<SrsState> {
  const s = await getScheduler();
  const at = new Date(now);
  // ts-fsrs validates a cardId on the card; our identity lives outside SrsState.
  const card = srs ? { ...toSched(srs), cardId: 'card' } : s.newCard({ now: at });
  const r = s.review({ card: card as any, grade: grade as FsrsGrade, now: at });
  return fromSched(r.card as unknown as Record<string, unknown>);
}

export type CardStatus = 'new' | 'learning' | 'due' | 'learned';
export const LEARNED_STABILITY_DAYS = 21;

export function cardStatus(card: Card, now: number): CardStatus {
  const s = card.srs;
  if (!s) return 'new';
  if (s.dueAt <= now) return 'due';
  if (s.state === State.Review && s.stability > LEARNED_STABILITY_DAYS) return 'learned';
  return 'learning';
}

export function isDue(card: Card, now: number): boolean {
  return !!card.srs && card.srs.dueAt <= now;
}

// "Play the next move" quiz as a pure state machine. The UI dispatches events and
// persists the returned outcomes; nothing here touches storage or the DOM.
import { Chess } from 'chess.js';
import { isAccepted } from './accept';
import { commentFor } from './cards';
import { posKey } from './fen';
import { gradeAnswer, type Grade } from './scheduler';
import type { OpeningIndex } from './tree';
import type { AcceptedMove, Card, TreeNode } from './types';

export interface QuizContext {
  cards: Map<string, Card>;
  indexes: Map<string, OpeningIndex>;
  /** openingId -> allowed lineIds (missing = all lines) */
  lineFilter?: Record<string, string[]>;
  /** re-show cards graded Again at the end of the session (due mode) */
  requeueLapses: boolean;
  rng: () => number;
}

export type Phase = 'awaiting' | 'wrong' | 'answered' | 'done';

export interface SessionResult {
  cardId: string;
  grade?: Grade; // undefined when skipped
  skipped?: boolean;
}

export interface Outcome {
  cardId: string;
  grade: Grade;
}

export interface NextMoveState {
  queue: string[]; // queue[0] is the current card unless phase === 'done'
  phase: Phase;
  displayFen: string;
  lastMove?: [string, string];
  attempts: number;
  hintUsed: boolean;
  revealed: boolean;
  shownAt: number;
  played?: AcceptedMove;
  wrongMove?: string;
  comment?: string;
  requeued: string[];
  results: SessionResult[];
}

export function currentCard(state: NextMoveState, ctx: QuizContext): Card | undefined {
  return state.phase === 'done' ? undefined : ctx.cards.get(state.queue[0]);
}

function showCard(state: NextMoveState, ctx: QuizContext, now: number, lastMove?: [string, string]): NextMoveState {
  const card = ctx.cards.get(state.queue[0]);
  if (!card) return { ...state, phase: 'done', lastMove: undefined };
  return {
    ...state,
    phase: 'awaiting',
    displayFen: card.fen,
    lastMove,
    attempts: 0,
    hintUsed: false,
    revealed: false,
    shownAt: now,
    played: undefined,
    wrongMove: undefined,
    comment: undefined,
  };
}

export function startNextMove(ctx: QuizContext, cardIds: string[], now: number): NextMoveState {
  const base: NextMoveState = {
    queue: cardIds.filter((id) => ctx.cards.has(id)),
    phase: 'awaiting',
    displayFen: '',
    attempts: 0,
    hintUsed: false,
    revealed: false,
    shownAt: now,
    requeued: [],
    results: [],
  };
  return showCard(base, ctx, now);
}

function applyMove(fen: string, uci: string): { fen: string; from: string; to: string } {
  const c = new Chess(fen);
  const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: c.fen(), from: m.from, to: m.to };
}

function answered(state: NextMoveState, ctx: QuizContext, card: Card, move: AcceptedMove, now: number, correct: boolean) {
  const grade = gradeAnswer({
    correct,
    wrongAttempts: state.attempts,
    hintUsed: state.hintUsed,
    revealed: state.revealed,
    ms: now - state.shownAt,
    srs: card.srs,
  });
  const after = applyMove(card.fen, move.uci);
  const index = ctx.indexes.get(card.openingId);
  const next: NextMoveState = {
    ...state,
    phase: 'answered',
    played: move,
    displayFen: after.fen,
    lastMove: [after.from, after.to],
    comment: (index && commentFor(index, card, move.uci)) ?? undefined,
    results: [...state.results, { cardId: card.id, grade }],
  };
  return { state: next, outcome: { cardId: card.id, grade } as Outcome };
}

/** Learner played `uci` on the board. */
export function playMove(state: NextMoveState, ctx: QuizContext, uci: string, now: number): { state: NextMoveState; outcome?: Outcome } {
  const card = currentCard(state, ctx);
  if (!card || (state.phase !== 'awaiting' && state.phase !== 'wrong')) return { state };
  const hit = isAccepted(card, uci);
  if (hit) return answered(state, ctx, card, hit, now, true);
  return {
    state: { ...state, phase: 'wrong', attempts: state.attempts + 1, wrongMove: uci, displayFen: card.fen },
  };
}

export function useHint(state: NextMoveState): NextMoveState {
  return state.phase === 'awaiting' || state.phase === 'wrong' ? { ...state, hintUsed: true } : state;
}

/** Square to highlight for a hint: origin of the first book move. */
export function hintSquare(state: NextMoveState, ctx: QuizContext): string | undefined {
  return currentCard(state, ctx)?.accepted[0]?.uci.slice(0, 2);
}

export function reveal(state: NextMoveState, ctx: QuizContext, now: number): { state: NextMoveState; outcome?: Outcome } {
  const card = currentCard(state, ctx);
  if (!card || (state.phase !== 'awaiting' && state.phase !== 'wrong')) return { state };
  return answered({ ...state, revealed: true }, ctx, card, card.accepted[0], now, false);
}

export function skip(state: NextMoveState, ctx: QuizContext, now: number): NextMoveState {
  const card = currentCard(state, ctx);
  if (!card) return state;
  const s = { ...state, queue: state.queue.slice(1), results: [...state.results, { cardId: card.id, skipped: true }] };
  return showCard(s, ctx, now);
}

/** Opponent book replies after the learner's move, respecting the line filter when possible. */
export function opponentReplies(ctx: QuizContext, card: Card, uci: string): TreeNode[] {
  const index = ctx.indexes.get(card.openingId);
  if (!index) return [];
  const allowed = ctx.lineFilter?.[card.openingId];
  const allowedSet = allowed?.length ? new Set(allowed) : null;
  const replies = new Map<string, TreeNode>();
  for (const twin of index.byPos.get(card.posKey) ?? []) {
    const after = twin.children.find((c) => c.uci === uci);
    for (const r of after?.children ?? []) {
      if (allowedSet && !(index.linesThrough.get(r.id) ?? []).some((l) => allowedSet.has(l))) continue;
      if (!replies.has(r.uci)) replies.set(r.uci, r);
    }
  }
  return [...replies.values()];
}

/**
 * Move on after an answer: the opponent replies from the book and, when the resulting
 * position is still queued, it becomes the next card so lines flow naturally.
 */
export function advance(state: NextMoveState, ctx: QuizContext, now: number): NextMoveState {
  const card = currentCard(state, ctx);
  if (!card || state.phase !== 'answered' || !state.played) return state;
  let queue = state.queue.slice(1);
  let requeued = state.requeued;
  const last = state.results[state.results.length - 1];
  if (ctx.requeueLapses && last?.grade === 1 && !requeued.includes(card.id)) {
    queue = [...queue, card.id];
    requeued = [...requeued, card.id];
  }

  const replies = opponentReplies(ctx, card, state.played.uci);
  let lastMove: [string, string] | undefined;
  if (replies.length) {
    const reply = replies[Math.floor(ctx.rng() * replies.length)];
    const nextId = `${card.openingId}|${posKey(reply.fen)}`;
    const at = queue.indexOf(nextId);
    if (at > 0) queue = [nextId, ...queue.slice(0, at), ...queue.slice(at + 1)];
    if (at >= 0) lastMove = [reply.uci.slice(0, 2), reply.uci.slice(2, 4)];
  }
  return showCard({ ...state, queue, requeued }, ctx, now, lastMove);
}

export interface SessionSummary {
  reviewed: number;
  correct: number;
  skipped: number;
  accuracy: number; // 0..1 over graded answers
  byGrade: Record<Grade, number>;
}

export function summarize(results: SessionResult[]): SessionSummary {
  const graded = results.filter((r) => r.grade);
  const byGrade: Record<Grade, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of graded) byGrade[r.grade!]++;
  const correct = graded.filter((r) => r.grade! > 1).length;
  return {
    reviewed: graded.length,
    correct,
    skipped: results.length - graded.length,
    accuracy: graded.length ? correct / graded.length : 0,
    byGrade,
  };
}

// ---------- queues ----------

export function dueQueue(cards: Card[], now: number, newLimit: number): string[] {
  const due = cards.filter((c) => c.srs && c.srs.dueAt <= now).sort((a, b) => a.srs!.dueAt - b.srs!.dueAt);
  const fresh = cards.filter((c) => !c.srs).slice(0, Math.max(0, newLimit));
  return [...due, ...fresh].map((c) => c.id);
}

export function practiceQueue(cards: Card[]): string[] {
  return cards.map((c) => c.id);
}

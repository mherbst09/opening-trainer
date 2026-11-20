// "Full line recall": play a whole line from move 1 without the board telling you
// anything. Pure state machine like quiz.ts; the UI persists the returned outcomes.
import { Chess } from 'chess.js';
import { isAccepted } from './accept';
import { cardId } from './cards';
import { posKey, sideToMove } from './fen';
import { stripAnnotations } from '../content/pgnTree';
import type { Grade } from './scheduler';
import type { Outcome, QuizContext } from './quiz';
import type { AcceptedMove, Card, Line, TreeNode } from './types';

export interface LineQuizOptions {
  stopAtFirstMistake: boolean;
}

export type LinePhase =
  | 'awaiting' // learner to move
  | 'opponent' // learner moved; opponent reply pending (UI calls opponentStep)
  | 'mistake' // wrong move; learner must play the book move or reveal it
  | 'line-done' // line finished or stopped; UI shows the line summary
  | 'done';

export type MoveMark = 'correct' | 'hint' | 'mistake' | 'alternative';

export interface PlyResult {
  ply: number; // index into path
  cardId: string;
  expected: AcceptedMove;
  played?: string; // uci of the first attempt
  playedSan?: string;
  mark: MoveMark;
  grade: Grade;
}

export interface LineResult {
  startLineId: string;
  lineId: string; // line actually finished (after switching to an alternative branch)
  plies: PlyResult[];
  learnerMoves: number; // learner moves in the line (incl. ungraded after a stop)
  stopped: boolean;
}

export interface LineQuizState {
  queue: string[]; // line ids; queue[0] is the current line until 'done'
  lineId: string;
  path: TreeNode[]; // nodes of the line being followed (root excluded)
  ply: number; // index of the next node to be played
  phase: LinePhase;
  displayFen: string;
  lastMove?: [string, string];
  hintUsed: boolean;
  wrongMove?: string;
  note?: string; // e.g. "Also book — continuing with the main line"
  comment?: string;
  current: PlyResult[];
  results: LineResult[];
}


function lineById(ctx: QuizContext, id: string): Line | undefined {
  for (const idx of ctx.indexes.values()) {
    const l = idx.lines.find((x) => x.id === id);
    if (l) return l;
  }
  return undefined;
}

function rootOf(ctx: QuizContext, line: Line): TreeNode {
  return ctx.indexes.get(line.openingId)!.opening.root;
}

function learnerSide(ctx: QuizContext, line: Line) {
  return ctx.indexes.get(line.openingId)!.opening.side;
}

function fenBefore(ctx: QuizContext, line: Line, path: TreeNode[], ply: number): string {
  return ply === 0 ? rootOf(ctx, line).fen : path[ply - 1].fen;
}

function cardAt(ctx: QuizContext, openingId: string, fen: string): Card | undefined {
  return ctx.cards.get(cardId(openingId, posKey(fen)));
}

const moveSquares = (uci: string): [string, string] => [uci.slice(0, 2), uci.slice(2, 4)];

/** Auto-play opponent moves until it is the learner's turn or the line ends. */
function settle(s: LineQuizState, ctx: QuizContext, line: Line): LineQuizState {
  let { ply, lastMove } = s;
  const side = learnerSide(ctx, line);
  while (ply < s.path.length && sideToMove(fenBefore(ctx, line, s.path, ply)) !== side) {
    lastMove = moveSquares(s.path[ply].uci);
    ply++;
  }
  const displayFen = fenBefore(ctx, line, s.path, ply);
  if (ply >= s.path.length) return finishLine({ ...s, ply, displayFen, lastMove }, ctx, false);
  return { ...s, ply, displayFen, lastMove, phase: 'awaiting', hintUsed: false, wrongMove: undefined };
}

function loadLine(s: LineQuizState, ctx: QuizContext): LineQuizState {
  while (s.queue.length) {
    const line = lineById(ctx, s.queue[0]);
    if (line) {
      const fresh: LineQuizState = {
        ...s, lineId: line.id, path: line.nodes, ply: 0, current: [], note: undefined, comment: undefined,
        lastMove: undefined, displayFen: rootOf(ctx, line).fen, phase: 'awaiting', hintUsed: false, wrongMove: undefined,
      };
      return settle(fresh, ctx, line);
    }
    s = { ...s, queue: s.queue.slice(1) };
  }
  return { ...s, phase: 'done' };
}

function finishLine(s: LineQuizState, ctx: QuizContext, stopped: boolean): LineQuizState {
  const line = lineById(ctx, s.lineId)!;
  const side = learnerSide(ctx, line);
  let learnerMoves = 0;
  s.path.forEach((_, i) => { if (sideToMove(fenBefore(ctx, line, s.path, i)) === side) learnerMoves++; });
  const result: LineResult = {
    startLineId: s.queue[0],
    lineId: s.lineId,
    plies: s.current,
    learnerMoves,
    stopped,
  };
  return { ...s, phase: 'line-done', results: [...s.results, result] };
}

export function startLineQuiz(ctx: QuizContext, lineIds: string[]): LineQuizState {
  return loadLine({
    queue: lineIds, lineId: '', path: [], ply: 0, phase: 'awaiting', displayFen: '',
    hintUsed: false, current: [], results: [],
  }, ctx);
}

export function expectedMove(s: LineQuizState): TreeNode | undefined {
  return s.phase === 'awaiting' || s.phase === 'mistake' ? s.path[s.ply] : undefined;
}

export function lineHintSquare(s: LineQuizState): string | undefined {
  return expectedMove(s)?.uci.slice(0, 2);
}

export function lineUseHint(s: LineQuizState): LineQuizState {
  return s.phase === 'awaiting' ? { ...s, hintUsed: true } : s;
}

function record(s: LineQuizState, ctx: QuizContext, line: Line, mark: MoveMark, grade: Grade, played?: string, playedSan?: string) {
  const fen = fenBefore(ctx, line, s.path, s.ply);
  const card = cardAt(ctx, line.openingId, fen);
  const exp = s.path[s.ply];
  const ply: PlyResult = {
    ply: s.ply,
    cardId: card?.id ?? cardId(line.openingId, posKey(fen)),
    expected: { uci: exp.uci, san: exp.san },
    played,
    playedSan,
    mark,
    grade,
  };
  return { ply, outcome: card ? ({ cardId: card.id, grade } as Outcome) : undefined };
}

/** Learner moved: book move on this line, alternative book move, or mistake. */
export function linePlayMove(
  s: LineQuizState, ctx: QuizContext, opts: LineQuizOptions, uci: string,
): { state: LineQuizState; outcome?: Outcome } {
  if (s.phase !== 'awaiting' && s.phase !== 'mistake') return { state: s };
  const line = lineById(ctx, s.lineId)!;
  const fen = fenBefore(ctx, line, s.path, s.ply);
  const expected = s.path[s.ply];
  const card = cardAt(ctx, line.openingId, fen);
  const hit = card ? isAccepted(card, uci) : expected.uci === uci ? { uci, san: expected.san } : undefined;

  if (s.phase === 'mistake') {
    // Already graded as a lapse; only the book move continues the line.
    if (hit?.uci !== expected.uci) return { state: { ...s, wrongMove: uci } };
    return { state: advanceAfterLearner({ ...s, wrongMove: undefined }, ctx, expected) };
  }

  if (hit) {
    let state = s;
    let mark: MoveMark = s.hintUsed ? 'hint' : 'correct';
    let note: string | undefined;
    let node = expected;
    if (hit.uci !== expected.uci) {
      mark = s.hintUsed ? 'hint' : 'alternative';
      const switched = switchBranch(s, ctx, line, hit.uci);
      if (switched) {
        state = switched;
        node = switched.path[s.ply];
        note = `${hit.san} is also book — continuing with “${lineById(ctx, switched.lineId)!.name}”.`;
      } else {
        note = `${hit.san} is also book, but this line continues with ${expected.san}.`;
      }
    }
    const grade: Grade = s.hintUsed ? 2 : 3;
    const { ply, outcome } = record(state, ctx, line, mark, grade, uci, hit.san);
    const next = { ...state, current: [...state.current, ply], note };
    return { state: advanceAfterLearner(next, ctx, node), outcome };
  }

  // Mistake: lapse for this position.
  const { ply, outcome } = record(s, ctx, line, 'mistake', 1, uci, sanOf(fen, uci));
  const withMistake = { ...s, current: [...s.current, ply], wrongMove: uci, note: undefined };
  if (opts.stopAtFirstMistake) {
    return { state: finishLine({ ...withMistake, displayFen: fen }, ctx, true), outcome };
  }
  return { state: { ...withMistake, phase: 'mistake', displayFen: fen }, outcome };
}

/** Play the expected move for the learner after a mistake (no further penalty). */
export function lineReveal(s: LineQuizState, ctx: QuizContext): LineQuizState {
  if (s.phase !== 'mistake') return s;
  return advanceAfterLearner({ ...s, wrongMove: undefined }, ctx, s.path[s.ply]);
}

function advanceAfterLearner(s: LineQuizState, ctx: QuizContext, node: TreeNode): LineQuizState {
  const ply = s.ply + 1;
  const comment = node.comment ? stripAnnotations(node.comment) || undefined : undefined;
  const next: LineQuizState = {
    ...s, ply, displayFen: node.fen, lastMove: moveSquares(node.uci), hintUsed: false, comment: comment ?? s.comment,
  };
  if (ply >= s.path.length) return finishLine(next, ctx, false);
  return { ...next, phase: 'opponent' };
}

/** Apply the opponent's reply (UI calls this after a short delay for animation). */
export function opponentStep(s: LineQuizState, ctx: QuizContext): LineQuizState {
  if (s.phase !== 'opponent') return s;
  const line = lineById(ctx, s.lineId)!;
  const node = s.path[s.ply];
  const comment = node.comment ? stripAnnotations(node.comment) || undefined : undefined;
  return settle({ ...s, comment: comment ?? s.comment }, ctx, line);
}

/** Learner chose an alternative book move that branches here: follow that branch. */
function switchBranch(s: LineQuizState, ctx: QuizContext, line: Line, uci: string): LineQuizState | undefined {
  const index = ctx.indexes.get(line.openingId)!;
  const parent = s.ply === 0 ? index.opening.root : s.path[s.ply - 1];
  const child = parent.children.find((c) => c.uci === uci);
  if (!child) return undefined;
  const allowed = ctx.lineFilter?.[line.openingId];
  const candidates = index.lines.filter((l) => l.nodes[s.ply]?.id === child.id);
  const pick = candidates.find((l) => !allowed?.length || allowed.includes(l.id)) ?? candidates[0];
  if (!pick) return undefined;
  return { ...s, lineId: pick.id, path: pick.nodes };
}

export function nextLine(s: LineQuizState, ctx: QuizContext): LineQuizState {
  if (s.phase !== 'line-done') return s;
  return loadLine({ ...s, queue: s.queue.slice(1) }, ctx);
}

export function quitLines(s: LineQuizState): LineQuizState {
  return { ...s, phase: 'done' };
}

export interface LineSessionSummary {
  lines: number;
  perfect: number;
  stopped: number;
  moves: number;
  correct: number;
  accuracy: number;
}

export function summarizeLines(results: LineResult[]): LineSessionSummary {
  let moves = 0;
  let correct = 0;
  for (const r of results) {
    moves += r.plies.length;
    correct += r.plies.filter((p) => p.mark !== 'mistake').length;
  }
  return {
    lines: results.length,
    perfect: results.filter((r) => !r.stopped && r.plies.every((p) => p.mark === 'correct' || p.mark === 'alternative')).length,
    stopped: results.filter((r) => r.stopped).length,
    moves,
    correct,
    accuracy: moves ? correct / moves : 0,
  };
}

// ---------- line queues ----------

/** Card ids for the learner's positions along a line. */
export function lineCardIds(ctx: QuizContext, line: Line): string[] {
  const side = learnerSide(ctx, line);
  const ids: string[] = [];
  line.nodes.forEach((_, i) => {
    const fen = fenBefore(ctx, line, line.nodes, i);
    if (sideToMove(fen) === side) ids.push(cardId(line.openingId, posKey(fen)));
  });
  return ids;
}

/**
 * Due mode: the fewest lines that cover every due position (most overdue first), then
 * lines that introduce new positions while the daily new-card budget lasts. Lines that
 * share an opening prefix are not repeated just because the shared moves are due.
 */
export function dueLineQueue(ctx: QuizContext, lines: Line[], now: number, newLimit: number): string[] {
  const info = lines.map((line) => {
    const ids = lineCardIds(ctx, line);
    const cards = ids.map((id) => ctx.cards.get(id)).filter(Boolean) as Card[];
    const due = cards.filter((c) => c.srs && c.srs.dueAt <= now);
    return {
      line,
      ids,
      due: due.map((c) => c.id),
      firstDue: due.length ? Math.min(...due.map((c) => c.srs!.dueAt)) : Infinity,
      fresh: cards.filter((c) => !c.srs).map((c) => c.id),
    };
  });
  const covered = new Set<string>();
  const out: string[] = [];
  for (const x of [...info].sort((a, b) => a.firstDue - b.firstDue)) {
    if (!x.due.some((id) => !covered.has(id))) continue;
    out.push(x.line.id);
    x.ids.forEach((id) => covered.add(id));
  }
  let budget = newLimit;
  for (const x of info) {
    if (budget <= 0) break;
    if (out.includes(x.line.id)) continue;
    const unseen = x.fresh.filter((id) => !covered.has(id));
    if (!unseen.length) continue;
    out.push(x.line.id);
    budget -= unseen.length;
    x.ids.forEach((id) => covered.add(id));
  }
  return out;
}

function sanOf(fen: string, uci: string): string | undefined {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return undefined;
  }
}

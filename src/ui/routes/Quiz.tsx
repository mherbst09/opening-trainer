import { useCallback, useEffect, useState } from 'react';
import { GRADE_NAME } from '../../engine/scheduler';
import {
  advance, currentCard, dueQueue, hintSquare, playMove, practiceQueue, reveal, skip,
  startNextMove, summarize, useHint as applyHint, type NextMoveState,
} from '../../engine/quiz';
import type { Side } from '../../engine/types';
import { Board, type Arrow } from '../components/Board';
import { useAppData } from '../data';
import { navigate } from '../router';
import { DueStats, usePersister, useSessionBase, type SessionBase } from '../quizSession';
import { LineQuiz } from './LineQuiz';
import { syncAfterSession } from '../../sync/instance';

/** Dispatch on ?m=line (full line recall) vs the default next-move mode. */
export function Quiz({ params }: { params: URLSearchParams }) {
  return params.get('m') === 'line' ? <LineQuiz params={params} /> : <NextMoveQuiz params={params} />;
}

function NextMoveQuiz({ params }: { params: URLSearchParams }) {
  const data = useAppData();
  const base = useSessionBase(params);
  const [state, setState] = useState<NextMoveState | null>(null);
  const [total, setTotal] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const persist = usePersister(base, data.settings, 'next-move', false);

  useEffect(() => {
    if (!base || state) return;
    const queue = base.kind === 'due' ? dueQueue(base.cards, Date.now(), base.newBudget) : practiceQueue(base.cards);
    setTotal(queue.length);
    setState(startNextMove(base.ctx, queue, Date.now()));
  }, [base, state]);

  const ctx = base?.ctx;
  const card = state && ctx ? currentCard(state, ctx) : undefined;
  const opening = card ? data.indexes.get(card.openingId)?.opening : undefined;
  const side: Side = opening?.side ?? 'white';
  const orientation: Side = flipped ? (side === 'white' ? 'black' : 'white') : side;

  const onMove = (uci: string) => {
    if (!state || !ctx) return;
    const r = playMove(state, ctx, uci, Date.now());
    setState(r.state);
    void persist(r.outcome);
  };
  const doHint = () => state && setState(applyHint(state));
  const doReveal = () => {
    if (!state || !ctx) return;
    const r = reveal(state, ctx, Date.now());
    setState(r.state);
    void persist(r.outcome);
  };
  const doSkip = () => state && ctx && setState(skip(state, ctx, Date.now()));
  const doNext = useCallback(() => {
    if (state && ctx && state.phase === 'answered') setState(advance(state, ctx, Date.now()));
  }, [state, ctx]);
  const quit = () => state && setState({ ...state, phase: 'done' });

  // Auto-continue when there is no comment to read.
  useEffect(() => {
    if (state?.phase !== 'answered' || state.comment) return;
    const t = setTimeout(doNext, 700);
    return () => clearTimeout(t);
  }, [state, doNext]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!state || state.phase === 'done') return;
      const k = e.key.toLowerCase();
      if (k === 'enter') { e.preventDefault(); if (state.phase === 'answered') doNext(); else if (state.phase === 'wrong') doReveal(); }
      else if (k === 'h') doHint();
      else if (k === 'f') setFlipped((f) => !f);
      else if (k === 's') doSkip();
      else if (k === 'r' && state.phase === 'wrong') doReveal();
      else if (k === 'escape') quit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!base || !state || !ctx) return <div className="page"><p>Preparing quiz…</p></div>;
  if (state.phase === 'done' || !card) return <Summary state={state} base={base} total={total} />;

  const done = state.results.length;
  const arrows: Arrow[] = [];
  if (state.phase === 'wrong') {
    for (const m of card.accepted) arrows.push({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), brush: 'green' });
    if (state.wrongMove) arrows.push({ from: state.wrongMove.slice(0, 2), to: state.wrongMove.slice(2, 4), brush: 'red' });
  }
  const lastGrade = state.results[state.results.length - 1]?.grade;

  return (
    <div className="page play">
      <div className="board-col">
        <Board
          fen={state.displayFen}
          orientation={orientation}
          interactive={state.phase === 'awaiting' || state.phase === 'wrong'}
          onMove={onMove}
          lastMove={state.lastMove}
          hintSquare={state.hintUsed && state.phase !== 'answered' ? hintSquare(state, ctx) : undefined}
          arrows={arrows}
        />
        <div className="controls">
          {state.phase === 'answered' ? (
            <button className="btn primary grow" onClick={doNext}>Next ⏎</button>
          ) : state.phase === 'wrong' ? (
            <>
              <button className="btn grow" onClick={doReveal}>Reveal</button>
              <span className="muted grow center">or play it again</span>
            </>
          ) : (
            <>
              <button className="btn grow" onClick={doHint} disabled={state.hintUsed}>Hint</button>
              <button className="btn grow" onClick={doSkip}>Skip</button>
            </>
          )}
          <button className="btn" onClick={() => setFlipped((f) => !f)} aria-label="Flip board">⇅</button>
          <button className="btn" onClick={quit} aria-label="Quit session">✕</button>
        </div>
      </div>

      <aside className="panel">
        <header className="panel-head">
          <div className="quiz-progress">
            <span>{opening?.name}</span>
            <span className="muted">{done} answered · {state.queue.length} left</span>
          </div>
          <div className="bar"><div style={{ width: `${(done / Math.max(1, done + state.queue.length)) * 100}%` }} /></div>
        </header>

        <div className={`feedback ${state.phase}`} aria-live="polite">
          {state.phase === 'awaiting' && <p>Your move{state.hintUsed ? ' (hint shown)' : ''}. You play {side}.</p>}
          {state.phase === 'wrong' && (
            <p><strong>Not the book move.</strong> The green arrow shows {card.accepted.length > 1 ? 'the book moves' : 'the book move'}: {card.accepted.map((m) => m.san).join(' / ')}. Play it, or reveal.</p>
          )}
          {state.phase === 'answered' && (
            <>
              <p>
                <strong>{state.revealed ? 'Revealed' : lastGrade && lastGrade > 1 ? 'Correct' : 'Correct on retry'}:</strong> {state.played?.san}
                {lastGrade && <span className={`grade g${lastGrade}`}>{GRADE_NAME[lastGrade]}</span>}
              </p>
              {state.comment && <p className="comment">{state.comment}</p>}
            </>
          )}
        </div>
        <p className="muted small keys">Keys: H hint · S skip · F flip · Enter next · Esc quit</p>
      </aside>
    </div>
  );
}

function Summary({ state, base, total }: { state: NextMoveState; base: SessionBase; total: number }) {
  const s = summarize(state.results);
  useEffect(() => syncAfterSession(), []);
  return (
    <div className="page narrow">
      <h1>Session summary</h1>
      <dl className="stats">
        <div><dt>Cards reviewed</dt><dd>{s.reviewed}</dd></div>
        <div><dt>Accuracy</dt><dd>{s.reviewed ? Math.round(s.accuracy * 100) : 0}%</dd></div>
        <div><dt>Skipped</dt><dd>{s.skipped}</dd></div>
        <DueStats openingIds={base.openingIds} />
      </dl>
      <p className="muted">Again {s.byGrade[1]} · Hard {s.byGrade[2]} · Good {s.byGrade[3]} · Easy {s.byGrade[4]}</p>
      {total === 0 && <p>Nothing due in this selection right now. Use “Start quiz on this opening” in Learn mode to practise everything.</p>}
      <div className="panel-actions">
        <button className="btn primary big" onClick={() => navigate('')}>Home</button>
      </div>
    </div>
  );
}

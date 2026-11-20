import { useEffect, useMemo, useState } from 'react';
import {
  dueLineQueue, lineHintSquare, linePlayMove, lineReveal, lineUseHint, nextLine, opponentStep,
  quitLines, startLineQuiz, summarizeLines, type LineQuizState, type LineResult,
} from '../../engine/lineQuiz';
import { formatMove } from '../../engine/tree';
import type { Line, Side } from '../../engine/types';
import { repo } from '../../db/repo';
import { Board, type Arrow } from '../components/Board';
import { useAppData } from '../data';
import { navigate } from '../router';
import { DueStats, usePersister, useSessionBase, type SessionBase } from '../quizSession';
import { syncAfterSession } from '../../sync/instance';

const MARK: Record<string, string> = { correct: '✓', alternative: '✓', hint: '◐', mistake: '✗' };

export function LineQuiz({ params }: { params: URLSearchParams }) {
  const data = useAppData();
  const base = useSessionBase(params);
  const [state, setState] = useState<LineQuizState | null>(null);
  const [flipped, setFlipped] = useState(false);
  const persist = usePersister(base, data.settings, 'full-line', true);
  const opts = { stopAtFirstMistake: data.settings.stopAtFirstMistake };

  const lines = useMemo(() => {
    if (!base) return [] as Line[];
    return base.openingIds.flatMap((id) => {
      const all = data.indexes.get(id)!.lines;
      const f = base.lineFilter[id];
      return f?.length ? all.filter((l) => f.includes(l.id)) : all;
    });
  }, [base, data.indexes]);

  useEffect(() => {
    if (!base || state) return;
    const queue = base.kind === 'due' ? dueLineQueue(base.ctx, lines, Date.now(), base.newBudget) : lines.map((l) => l.id);
    setState(startLineQuiz(base.ctx, queue));
  }, [base, state, lines]);

  const ctx = base?.ctx;
  const line = state && lines.length ? findLine(data.indexes, state.lineId) : undefined;
  const opening = line ? data.indexes.get(line.openingId)?.opening : undefined;
  const side: Side = opening?.side ?? 'white';
  const orientation: Side = flipped ? (side === 'white' ? 'black' : 'white') : side;

  // Opponent replies after a short pause so the move is visible.
  useEffect(() => {
    if (state?.phase !== 'opponent' || !ctx) return;
    const t = setTimeout(() => setState((s) => (s ? opponentStep(s, ctx) : s)), 450);
    return () => clearTimeout(t);
  }, [state, ctx]);

  const onMove = (uci: string) => {
    if (!state || !ctx) return;
    const r = linePlayMove(state, ctx, opts, uci);
    setState(r.state);
    void persist(r.outcome);
  };
  const doHint = () => state && setState(lineUseHint(state));
  const doReveal = () => state && ctx && setState(lineReveal(state, ctx));
  const doNextLine = () => state && ctx && setState(nextLine(state, ctx));
  const quit = () => state && setState(quitLines(state));
  const toggleStop = () => void repo.saveSettings({ stopAtFirstMistake: !data.settings.stopAtFirstMistake });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!state || state.phase === 'done') return;
      const k = e.key.toLowerCase();
      if (k === 'enter') {
        e.preventDefault();
        if (state.phase === 'line-done') doNextLine();
        else if (state.phase === 'mistake') doReveal();
      } else if (k === 'h') doHint();
      else if (k === 'f') setFlipped((f) => !f);
      else if (k === 'r' && state.phase === 'mistake') doReveal();
      else if (k === 'escape') quit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!base || !state || !ctx) return <div className="page"><p>Preparing lines…</p></div>;
  if (state.phase === 'done' || !line || !opening) return <LineSummary state={state} base={base} />;

  const expected = state.path[state.ply];
  const arrows: Arrow[] = [];
  if ((state.phase === 'mistake' || (state.phase === 'line-done' && state.results.at(-1)?.stopped)) && expected) {
    arrows.push({ from: expected.uci.slice(0, 2), to: expected.uci.slice(2, 4), brush: 'green' });
    if (state.wrongMove) arrows.push({ from: state.wrongMove.slice(0, 2), to: state.wrongMove.slice(2, 4), brush: 'red' });
  }
  const linesDone = state.results.length;
  const linesTotal = linesDone + state.queue.length - (state.phase === 'line-done' ? 1 : 0);
  const moveNo = Math.floor(state.ply / 2) + 1;
  const lastResult = state.phase === 'line-done' ? state.results.at(-1) : undefined;

  return (
    <div className="page play">
      <div className="board-col">
        <Board
          fen={state.displayFen}
          orientation={orientation}
          interactive={state.phase === 'awaiting' || state.phase === 'mistake'}
          onMove={onMove}
          lastMove={state.lastMove}
          hintSquare={state.hintUsed && state.phase === 'awaiting' ? lineHintSquare(state) : undefined}
          arrows={arrows}
        />
        <div className="controls">
          {state.phase === 'line-done' ? (
            <button className="btn primary grow" onClick={doNextLine}>{state.queue.length > 1 ? 'Next line ⏎' : 'Finish ⏎'}</button>
          ) : state.phase === 'mistake' ? (
            <>
              <button className="btn grow" onClick={doReveal}>Play it for me</button>
              <span className="muted grow center">or play the green move</span>
            </>
          ) : (
            <button className="btn grow" onClick={doHint} disabled={state.hintUsed || state.phase !== 'awaiting'}>Hint</button>
          )}
          <button className="btn" onClick={() => setFlipped((f) => !f)} aria-label="Flip board">⇅</button>
          <button className="btn" onClick={quit} aria-label="Quit session">✕</button>
        </div>
      </div>

      <aside className="panel">
        <header className="panel-head">
          <div className="quiz-progress">
            <span>{opening.name}: {line.name}</span>
            <span className="muted">line {Math.min(linesDone + 1, Math.max(1, linesTotal))} of {Math.max(1, linesTotal)}</span>
          </div>
          <div className="bar"><div style={{ width: `${(linesDone / Math.max(1, linesTotal)) * 100}%` }} /></div>
        </header>

        <div className={`feedback ${state.phase === 'mistake' ? 'wrong' : state.phase === 'line-done' ? 'answered' : ''}`} aria-live="polite">
          {state.phase === 'awaiting' && (
            <p>Play the line from memory, move {moveNo}. You play {side}.{state.hintUsed ? ' (hint shown)' : ''}</p>
          )}
          {state.phase === 'opponent' && <p>Opponent is replying…</p>}
          {state.phase === 'mistake' && (
            <p><strong>Not this line.</strong> The book move is {formatMove(state.displayFen, expected.san)}. Play it to continue (this position is marked for review).</p>
          )}
          {lastResult && <LineResultView result={lastResult} ctxLine={findLine(data.indexes, lastResult.lineId)!} rootFen={opening.root.fen} />}
          {state.note && state.phase !== 'line-done' && <p className="muted">{state.note}</p>}
          {state.comment && state.phase !== 'line-done' && <p className="comment">{state.comment}</p>}
        </div>

        <label className="toggle">
          <input type="checkbox" checked={data.settings.stopAtFirstMistake} onChange={toggleStop} aria-label="Stop the line at the first mistake" />
          <span>Stop the line at the first mistake</span>
        </label>
        <p className="muted small keys">Keys: H hint · F flip · Enter next/reveal · Esc quit</p>
      </aside>
    </div>
  );
}

function findLine(indexes: ReturnType<typeof useAppData>['indexes'], id: string): Line | undefined {
  for (const idx of indexes.values()) {
    const l = idx.lines.find((x) => x.id === id);
    if (l) return l;
  }
  return undefined;
}

function LineResultView({ result, ctxLine, rootFen }: { result: LineResult; ctxLine: Line; rootFen: string }) {
  const byPly = new Map(result.plies.map((p) => [p.ply, p]));
  const mistakes = result.plies.filter((p) => p.mark === 'mistake').length;
  return (
    <div className="line-result">
      <p>
        <strong>{result.stopped ? 'Stopped at the first mistake' : mistakes ? `Line finished with ${mistakes} mistake${mistakes > 1 ? 's' : ''}` : 'Perfect line!'}</strong>{' '}
        <span className="muted">({result.plies.length - mistakes}/{result.plies.length} correct)</span>
      </p>
      <ol className="movelist">
        {ctxLine.nodes.map((n, i) => {
          const pf = i === 0 ? rootFen : ctxLine.nodes[i - 1].fen;
          const p = byPly.get(i);
          const cls = p ? `mv res-${p.mark}` : 'mv ahead';
          return (
            <li key={n.id}>
              <span className={cls} title={p?.mark === 'mistake' ? `You played ${p.playedSan ?? p.played}` : undefined}>
                {formatMove(pf, n.san)}{p ? ` ${MARK[p.mark]}` : ''}
              </span>
            </li>
          );
        })}
      </ol>
      {result.plies.filter((p) => p.mark === 'mistake').map((p) => (
        <p key={p.ply} className="small">✗ Move {Math.floor(p.ply / 2) + 1}: you played <strong>{p.playedSan ?? p.played}</strong>, book is <strong>{p.expected.san}</strong>.</p>
      ))}
    </div>
  );
}

function LineSummary({ state, base }: { state: LineQuizState; base: SessionBase }) {
  const s = summarizeLines(state.results);
  useEffect(() => syncAfterSession(), []);
  return (
    <div className="page narrow">
      <h1>Line recall summary</h1>
      <dl className="stats">
        <div><dt>Lines played</dt><dd>{s.lines}</dd></div>
        <div><dt>Perfect lines</dt><dd>{s.perfect}</dd></div>
        <div><dt>Move accuracy</dt><dd>{s.moves ? Math.round(s.accuracy * 100) : 0}%</dd></div>
        <div><dt>Moves played</dt><dd>{s.moves}</dd></div>
        <DueStats openingIds={base.openingIds} />
      </dl>
      {s.lines === 0 && <p>No lines due in this selection right now. Choose “Recall all lines” in Learn mode to practise everything.</p>}
      <div className="panel-actions">
        <button className="btn primary big" onClick={() => navigate('')}>Home</button>
      </div>
    </div>
  );
}

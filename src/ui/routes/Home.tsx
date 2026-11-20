import { useMemo } from 'react';
import { useAppData } from '../data';
import { href } from '../router';
import { cleanSelection, selectionToParams } from '../../engine/selection';

export function Home() {
  const { openings, counts, loaded, sets, indexes, cardsFor } = useAppData();
  const now = Date.now();
  const rows = useMemo(() => openings.map((o) => ({ o, c: counts(o.id, now) })), [openings, counts, now]);
  const totalDue = rows.reduce((n, r) => n + r.c.due, 0);
  const totalNew = rows.reduce((n, r) => n + r.c.new, 0);
  const allIds = openings.map((o) => o.id).join(',');
  const anything = totalDue + totalNew > 0;

  return (
    <div className="page">
      <section className="hero">
        <div className="due-count" aria-live="polite">
          <div><strong>{loaded ? totalDue : '…'}</strong> due today</div>
          <div className="muted small">{totalNew} new positions not started yet</div>
        </div>
        <a className={`btn primary big ${anything ? '' : 'disabled'}`} href={href('quiz', { o: allIds, q: 'due' })} aria-disabled={!anything}>
          {totalDue ? 'Review due' : 'Learn new'}
        </a>
      </section>

      <div className="row-between">
        <h2>Your sets</h2>
        <a className="btn small" href="#/setup">+ New quiz / set</a>
      </div>
      {sets.length === 0 ? (
        <p className="muted small">Save a selection of openings (e.g. “White repertoire”) in Quiz setup to start it from here.</p>
      ) : (
        <ul className="set-list">
          {sets.map((s) => {
            const sel = cleanSelection({ openingIds: s.openingIds, lineFilter: s.lineFilter ?? {} }, indexes);
            let due = 0;
            for (const id of sel.openingIds) for (const c of cardsFor(id, sel.lineFilter[id])) if (c.srs && c.srs.dueAt <= now) due++;
            return (
              <li key={s.id} className="opening-row">
                <div className="opening-info">
                  <div className="opening-name">{s.name}</div>
                  <div className="opening-meta">{sel.openingIds.length} opening{sel.openingIds.length === 1 ? '' : 's'} · {due} due</div>
                </div>
                <div className="opening-actions">
                  <a className="btn" href={href('setup', { set: s.id })} aria-label={`Edit set ${s.name}`}>Edit</a>
                  <a className="btn primary" href={href('quiz', selectionToParams(sel, 'next-move', 'due'))}>Quiz</a>
                  <a className="btn" href={href('quiz', selectionToParams(sel, 'line', 'due'))} aria-label={`Full line recall: ${s.name}`}>Lines</a>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="row-between">
        <h2>Openings</h2>
        <a className="btn small" href="#/import">+ Import PGN</a>
      </div>
      <ul className="opening-list">
        {rows.map(({ o, c }) => (
          <li key={o.id} className="opening-row">
            <div className="opening-info">
              <div className="opening-name">{o.name}</div>
              <div className="opening-meta">
                <span className={`side-dot ${o.side}`} aria-hidden /> {o.side === 'white' ? 'White' : 'Black'}{o.eco ? ` · ${o.eco}` : ''}
                {o.source === 'imported' && <span className="badge">Imported</span>}
              </div>
              <div className="progress-pills">
                <span className="pill new">{c.new} new</span>
                <span className="pill learning">{c.learning} learning</span>
                <span className="pill due">{c.due} due</span>
                <span className="pill learned">{c.learned} learned</span>
              </div>
            </div>
            <div className="opening-actions">
              <a className="btn" href={href(`learn/${o.id}`)}>Learn</a>
              <a className="btn primary" href={href('quiz', { o: o.id, q: 'due' })}>Quiz</a>
              <a className="btn" href={href('quiz', { o: o.id, q: 'due', m: 'line' })} aria-label={`Full line recall: ${o.name}`}>Lines</a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

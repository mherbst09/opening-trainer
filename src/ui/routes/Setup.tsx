import { useEffect, useMemo, useState } from 'react';
import { repo } from '../../db/repo';
import {
  allTags, cleanSelection, ECO_FAMILIES, ECO_FAMILY_LABEL, EMPTY_FILTER, EMPTY_SELECTION, matchesFilter,
  selectionToParams, toggleLine, toggleOpening, type OpeningFilter, type QueueParam, type QuizModeParam, type Selection,
} from '../../engine/selection';
import { useAppData } from '../data';
import { navigate } from '../router';

export function Setup({ params }: { params: URLSearchParams }) {
  const data = useAppData();
  const [filter, setFilter] = useState<OpeningFilter>(EMPTY_FILTER);
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  const [mode, setMode] = useState<QuizModeParam>('next-move');
  const [queue, setQueue] = useState<QueueParam>('due');
  const [setId, setSetId] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [naming, setNaming] = useState<null | 'new' | 'rename'>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const activeSet = data.sets.find((s) => s.id === setId);

  const loadSet = (id: string) => {
    setSetId(id);
    setDirty(false);
    setConfirmDelete(false);
    setNaming(null);
    const s = data.sets.find((x) => x.id === id);
    setSel(s ? cleanSelection({ openingIds: s.openingIds, lineFilter: s.lineFilter ?? {} }, data.indexes) : EMPTY_SELECTION);
  };

  // ?set=<id> preselects a saved set (from Home).
  useEffect(() => {
    const wanted = params.get('set');
    if (wanted && data.loaded && !setId && data.sets.some((s) => s.id === wanted)) loadSet(wanted);
  }, [data.loaded, data.sets]);

  const update = (next: Selection) => { setSel(next); setDirty(true); };

  const visible = useMemo(() => data.openings.filter((o) => matchesFilter(o, filter)), [data.openings, filter]);
  const tags = useMemo(() => allTags(data.openings), [data.openings]);

  const stats = useMemo(() => {
    const now = Date.now();
    let positions = 0, due = 0, fresh = 0;
    for (const id of sel.openingIds) {
      for (const c of data.cardsFor(id, sel.lineFilter[id])) {
        positions++;
        if (!c.srs) fresh++;
        else if (c.srs.dueAt <= now) due++;
      }
    }
    return { positions, due, fresh };
  }, [sel, data]);

  const start = () => navigate('quiz', selectionToParams(sel, mode, queue));

  const saveName = async () => {
    const name = nameDraft.trim();
    if (!name) return;
    if (naming === 'rename' && activeSet) {
      await repo.renameSet(activeSet.id, name);
    } else {
      const s = await repo.saveSet({ name, openingIds: sel.openingIds, lineFilter: sel.lineFilter });
      setSetId(s.id);
      setDirty(false);
    }
    setNaming(null);
  };
  const saveChanges = async () => {
    if (!activeSet) return;
    await repo.saveSet({ id: activeSet.id, name: activeSet.name, openingIds: sel.openingIds, lineFilter: sel.lineFilter });
    setDirty(false);
  };
  const remove = async () => {
    if (!activeSet) return;
    await repo.deleteSet(activeSet.id);
    setSetId('');
    setConfirmDelete(false);
  };

  const toggleChip = (key: 'ecoFamilies' | 'tags', v: string) =>
    setFilter((f) => ({ ...f, [key]: f[key].includes(v) ? f[key].filter((x) => x !== v) : [...f[key], v] }));

  const selectShown = (on: boolean) => {
    let s = sel;
    for (const o of visible) s = toggleOpening(s, o.id, on);
    update(s);
  };

  return (
    <div className="page setup">
      <h1>Quiz setup</h1>

      <section className="card">
        <div className="row-between">
          <h2 className="tight">Saved sets</h2>
          {dirty && activeSet && <span className="muted small">unsaved changes</span>}
        </div>
        <div className="set-bar">
          <select value={setId} onChange={(e) => loadSet(e.target.value)} aria-label="Saved set">
            <option value="">— No set (custom selection) —</option>
            {data.sets.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.openingIds.length})</option>)}
          </select>
          <div className="btn-row wrap">
            {activeSet && dirty && <button className="btn primary" onClick={saveChanges}>Save changes</button>}
            <button className="btn" disabled={!sel.openingIds.length} onClick={() => { setNaming('new'); setNameDraft(''); }}>Save as new set</button>
            {activeSet && <button className="btn" onClick={() => { setNaming('rename'); setNameDraft(activeSet.name); }}>Rename</button>}
            {activeSet && (confirmDelete
              ? <button className="btn danger" onClick={remove}>Confirm delete</button>
              : <button className="btn" onClick={() => setConfirmDelete(true)}>Delete</button>)}
          </div>
          {naming && (
            <form className="btn-row" onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
              <input type="text" className="grow" autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
                placeholder={naming === 'new' ? 'Set name, e.g. White repertoire' : 'New name'} aria-label="Set name" />
              <button className="btn primary" type="submit" disabled={!nameDraft.trim()}>{naming === 'new' ? 'Save' : 'Rename'}</button>
              <button className="btn" type="button" onClick={() => setNaming(null)}>Cancel</button>
            </form>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="tight">Openings</h2>
        <input type="search" placeholder="Search name, ECO or tag" value={filter.query}
          onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))} aria-label="Search openings" className="full" />
        <div className="seg" role="group" aria-label="Side">
          {(['all', 'white', 'black'] as const).map((s) => (
            <button key={s} className={`seg-btn ${filter.side === s ? 'on' : ''}`} aria-pressed={filter.side === s}
              onClick={() => setFilter((f) => ({ ...f, side: s }))}>{s === 'all' ? 'Both sides' : s === 'white' ? 'I play White' : 'I play Black'}</button>
          ))}
        </div>
        <div className="chips" role="group" aria-label="ECO family">
          {ECO_FAMILIES.map((e) => (
            <button key={e} className={`chip ${filter.ecoFamilies.includes(e) ? 'on' : ''}`} aria-pressed={filter.ecoFamilies.includes(e)}
              onClick={() => toggleChip('ecoFamilies', e)}>{ECO_FAMILY_LABEL[e]}</button>
          ))}
        </div>
        {tags.length > 0 && (
          <div className="chips" role="group" aria-label="Tags">
            {tags.map((t) => (
              <button key={t} className={`chip ${filter.tags.includes(t) ? 'on' : ''}`} aria-pressed={filter.tags.includes(t)}
                onClick={() => toggleChip('tags', t)}>#{t}</button>
            ))}
          </div>
        )}
        <div className="row-between">
          <span className="muted small">Showing {visible.length} of {data.openings.length}</span>
          <div className="btn-row">
            <button className="btn small" onClick={() => selectShown(true)} disabled={!visible.length}>Select shown</button>
            <button className="btn small" onClick={() => selectShown(false)} disabled={!sel.openingIds.length}>Clear shown</button>
          </div>
        </div>

        <ul className="pick-list">
          {visible.map((o) => {
            const checked = sel.openingIds.includes(o.id);
            const lines = data.indexes.get(o.id)!.lines;
            const chosen = sel.lineFilter[o.id];
            const open = expanded.has(o.id);
            const c = data.counts(o.id);
            return (
              <li key={o.id} className={checked ? 'checked' : ''}>
                <label className="pick-row">
                  <input type="checkbox" checked={checked} aria-label={`Include ${o.name}`}
                    onChange={(e) => update(toggleOpening(sel, o.id, e.target.checked))} />
                  <span className="pick-main">
                    <span className="opening-name">{o.name}</span>
                    <span className="opening-meta">{o.eco} · {o.side === 'white' ? 'White' : 'Black'} · {c.due} due · {c.new} new</span>
                  </span>
                </label>
                {checked && lines.length > 1 && (
                  <button className="btn small ghost var-toggle" aria-expanded={open}
                    onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })}>
                    {chosen?.length ? `${chosen.length} of ${lines.length} variations` : `All ${lines.length} variations`} {open ? '▴' : '▾'}
                  </button>
                )}
                {checked && open && (
                  <ul className="var-list">
                    {lines.map((l) => {
                      const on = !chosen?.length || chosen.includes(l.id);
                      return (
                        <li key={l.id}>
                          <label className="pick-row small-row">
                            <input type="checkbox" checked={on} aria-label={`Variation ${l.name}`}
                              onChange={(e) => update(toggleLine(sel, o.id, l.id, lines.map((x) => x.id), e.target.checked))} />
                            <span>{l.name}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
          {!visible.length && <li className="muted">No openings match these filters.</li>}
        </ul>
      </section>

      <section className="card">
        <h2 className="tight">Mode</h2>
        <div className="seg" role="radiogroup" aria-label="Quiz mode">
          <button className={`seg-btn ${mode === 'next-move' ? 'on' : ''}`} role="radio" aria-checked={mode === 'next-move'} onClick={() => setMode('next-move')}>Play the next move</button>
          <button className={`seg-btn ${mode === 'line' ? 'on' : ''}`} role="radio" aria-checked={mode === 'line'} onClick={() => setMode('line')}>Full line recall</button>
        </div>
        <div className="seg" role="radiogroup" aria-label="Queue">
          <button className={`seg-btn ${queue === 'due' ? 'on' : ''}`} role="radio" aria-checked={queue === 'due'} onClick={() => setQueue('due')}>Due for review</button>
          <button className={`seg-btn ${queue === 'all' ? 'on' : ''}`} role="radio" aria-checked={queue === 'all'} onClick={() => setQueue('all')}>Practice all</button>
        </div>
        <p className="muted small">
          {queue === 'due'
            ? `Due positions first, then up to ${data.settings.newCardsPerDay} new ones per day.`
            : 'Everything in the selection. Correct answers on positions that are not due yet do not change their schedule; mistakes always count.'}
        </p>
      </section>

      <div className="start-bar">
        <span className="small">
          <strong>{sel.openingIds.length}</strong> opening{sel.openingIds.length === 1 ? '' : 's'} · {stats.positions} positions · {stats.due} due · {stats.fresh} new
        </span>
        <button className="btn primary big" disabled={!sel.openingIds.length} onClick={start}>Start</button>
      </div>
    </div>
  );
}

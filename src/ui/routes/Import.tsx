import { useMemo, useState } from 'react';
import { openingFromPgn, parsePgnTree, suggestImportMeta } from '../../content/pgnTree';
import { buildCards } from '../../engine/cards';
import { indexOpening } from '../../engine/tree';
import type { Side } from '../../engine/types';
import { repo } from '../../db/repo';
import { useAppData } from '../data';
import { navigate } from '../router';

const MAX_BYTES = 2 * 1024 * 1024;

export function Import() {
  const data = useAppData();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState('');
  const [mergeAll, setMergeAll] = useState(true);
  const [name, setName] = useState('');
  const [side, setSide] = useState<Side | ''>('');
  const [tags, setTags] = useState('');
  const [eco, setEco] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const parsed = useMemo(() => (text.trim() ? parsePgnTree(text, { allGames: mergeAll }) : null), [text, mergeAll]);

  // Prefill the form from headers until the user edits it.
  const applySuggestions = (t: string, fallbackName = '') => {
    if (touched || !t.trim()) return;
    const p = parsePgnTree(t);
    const s = suggestImportMeta(p.headers, p.games > 1);
    setName(s.name || fallbackName);
    setSide(s.side ?? '');
    setTags(s.tags.join(', '));
    setEco(s.eco);
  };

  const onText = (t: string) => { setText(t); setFileName(''); applySuggestions(t); };

  const onFile = async (file: File | undefined) => {
    setFileError('');
    if (!file) return;
    if (file.size > MAX_BYTES) { setFileError('That file is larger than 2 MB. Import a smaller PGN (one opening or study).'); return; }
    const t = await file.text();
    setText(t);
    setFileName(file.name);
    applySuggestions(t, file.name.replace(/\.(pgn|txt)$/i, ''));
  };

  const preview = useMemo(() => {
    if (!parsed || !parsed.root.children.length || !side) return null;
    const { opening } = openingFromPgn(text, { id: 'preview', source: 'imported', side, allGames: mergeAll });
    const index = indexOpening(opening);
    return { lines: index.lines, cards: buildCards(index).length };
  }, [parsed, text, side, mergeAll]);

  const nameTaken = data.openings.some((o) => o.name.toLowerCase() === name.trim().toLowerCase());
  const canSave = !!parsed && parsed.root.children.length > 0 && !!name.trim() && !!side && !saving;

  const save = async () => {
    if (!canSave || !side) return;
    setSaving(true);
    const id = crypto.randomUUID();
    const { opening } = openingFromPgn(text, {
      id, source: 'imported', name: name.trim(), side, eco: eco.trim().toUpperCase(), allGames: mergeAll,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    await repo.saveImportedOpening(opening);
    await data.refresh();
    navigate(`learn/${id}`);
  };

  const mark = () => setTouched(true);

  return (
    <div className="page setup">
      <h1>Import PGN</h1>
      <p className="muted small">Paste a PGN or choose a file. Variations and {'{comments}'} are kept. A study export with several chapters can be merged into one opening.</p>

      <section className="card">
        <label className="btn file-btn">
          <input type="file" accept=".pgn,.txt,application/x-chess-pgn,text/plain" onChange={(e) => void onFile(e.target.files?.[0])} />
          Choose PGN file…
        </label>
        {fileName && <span className="muted small">Loaded {fileName}</span>}
        {fileError && <p className="error small">{fileError}</p>}
        <textarea rows={8} value={text} onChange={(e) => onText(e.target.value)} spellCheck={false}
          placeholder={'[Event "My Caro-Kann"]\n\n1. e4 c6 2. d4 d5 3. Nc3 (3. e5 Bf5) 3... dxe4 *'} aria-label="PGN text" />
      </section>

      {parsed && (
        <section className="card">
          <h2 className="tight">Check</h2>
          {parsed.games > 1 && (
            <label className="toggle">
              <input type="checkbox" checked={mergeAll} onChange={(e) => setMergeAll(e.target.checked)} aria-label="Merge all games" />
              <span>Merge all {parsed.games} games into one opening ({mergeAll ? parsed.usedGames : 1} used)</span>
            </label>
          )}
          {parsed.errors.length > 0 && (
            <div className="problems">
              <strong>{parsed.errors.length} problem{parsed.errors.length > 1 ? 's' : ''}</strong>
              {parsed.root.children.length > 0 && <span className="muted small"> (affected branches are left out)</span>}
              <ul>{parsed.errors.slice(0, 8).map((e, i) => <li key={i} className="small">{e}</li>)}</ul>
              {parsed.errors.length > 8 && <p className="muted small">…and {parsed.errors.length - 8} more</p>}
            </div>
          )}
          {preview ? (
            <>
              <p className="small"><strong>{preview.lines.length}</strong> lines · <strong>{preview.cards}</strong> positions for you to answer</p>
              <ul className="line-preview">
                {preview.lines.slice(0, 12).map((l) => <li key={l.id} className="small">{l.name} <span className="muted">({Math.ceil(l.nodes.length / 2)} moves)</span></li>)}
              </ul>
              {preview.lines.length > 12 && <p className="muted small">…and {preview.lines.length - 12} more</p>}
              {preview.cards === 0 && <p className="error small">No positions where {side} is to move. Did you pick the right side?</p>}
            </>
          ) : parsed.root.children.length > 0 ? (
            <p className="muted small">Choose which side you play to see the preview.</p>
          ) : null}
        </section>
      )}

      <section className="card">
        <h2 className="tight">Details</h2>
        <label className="field">
          <span>Opening name</span>
          <input type="text" value={name} onChange={(e) => { mark(); setName(e.target.value); }} placeholder="e.g. Caro-Kann (my lines)" />
        </label>
        {nameTaken && <p className="muted small">An opening with this name already exists; both will be kept.</p>}
        <div className="field">
          <span>I play</span>
          <div className="seg" role="radiogroup" aria-label="Side you play">
            {(['white', 'black'] as const).map((s) => (
              <button key={s} className={`seg-btn ${side === s ? 'on' : ''}`} role="radio" aria-checked={side === s}
                onClick={() => { mark(); setSide(s); }}>{s === 'white' ? 'White' : 'Black'}</button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>Tags (comma separated)</span>
          <input type="text" value={tags} onChange={(e) => { mark(); setTags(e.target.value); }} placeholder="e4, solid, this week" />
        </label>
        <label className="field">
          <span>ECO code (optional)</span>
          <input type="text" value={eco} maxLength={3} onChange={(e) => { mark(); setEco(e.target.value); }} placeholder="B12" />
        </label>
      </section>

      <div className="start-bar">
        <span className="small">{canSave ? 'Ready to import' : !parsed ? 'Paste or choose a PGN' : !side ? 'Choose your side' : !name.trim() ? 'Enter a name' : 'Nothing to import'}</span>
        <button className="btn primary big" disabled={!canSave} onClick={() => void save()}>Import</button>
      </div>
    </div>
  );
}

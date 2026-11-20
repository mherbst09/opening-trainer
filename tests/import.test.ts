import { describe, it, expect } from 'vitest';
import { openingFromPgn, parsePgnTree, suggestImportMeta } from '../src/content/pgnTree';
import { enumerateLines } from '../src/engine/tree';

const STUDY = `[Event "My repertoire: Caro main"]
[Orientation "black"]

1. e4 c6 { Solid. } 2. d4 d5 3. Nc3 dxe4 *

[Event "My repertoire: Advance"]
[Orientation "black"]

1. e4 c6 { Another comment } 2. d4 d5 3. e5 { Advance } Bf5 *

[Event "Endgame"]
[FEN "8/8/8/8/8/8/8/k6K w - - 0 1"]
[SetUp "1"]

1. Kg2 *`;

describe('PGN import parsing', () => {
  it('first game only by default', () => {
    const r = parsePgnTree(STUDY);
    expect(r.games).toBe(3);
    expect(r.usedGames).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it('merges all games into one tree, keeps first comment, skips other start positions', () => {
    const r = parsePgnTree(STUDY, { allGames: true });
    expect(r.usedGames).toBe(2);
    expect(r.errors).toEqual(['Game 3: starts from a different position and was skipped']);
    const c6 = r.root.children[0].children[0];
    expect(c6.comment).toBe('Solid.');
    const d5 = c6.children[0].children[0];
    expect(d5.children.map((n) => n.san)).toEqual(['Nc3', 'e5']);
  });

  it('suggests name and side from headers', () => {
    const { headers } = parsePgnTree(STUDY);
    expect(suggestImportMeta(headers)).toMatchObject({ name: 'My repertoire: Caro main', side: 'black' });
    expect(suggestImportMeta(headers, true).name).toBe('My repertoire');
    expect(suggestImportMeta({ Opening: 'Scotch', ECO: 'C45', Side: 'white', Tags: 'e4, open' }))
      .toEqual({ name: 'Scotch', side: 'white', eco: 'C45', tags: ['e4', 'open'] });
    expect(suggestImportMeta({ Event: '?' }).name).toBe('');
  });

  it('reports illegal moves with their path and keeps the legal part', () => {
    const r = parsePgnTree('1. e4 e5 2. Nf3 Nc6 (2... Ke7 3. Bc4 Kxc4) 3. Bb5 *');
    expect(r.errors).toEqual(['Illegal move Kxc4 after e4 e5 Nf3 Ke7 Bc4']);
    expect(r.root.children[0].children[0].children[0].children.map((n) => n.san)).toEqual(['Nc6', 'Ke7']);
  });

  it('caps very large trees', () => {
    const r = parsePgnTree('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *', { maxNodes: 3 });
    expect(r.errors[0]).toMatch(/Stopped after 3 moves/);
  });

  it('imported opening uses the form values over headers', () => {
    const { opening, errors } = openingFromPgn(STUDY, {
      id: 'u1', source: 'imported', name: 'Caro-Kann', side: 'black', tags: ['e4'], eco: 'B12', allGames: true, updatedAt: 5,
    });
    expect(errors).toHaveLength(1); // skipped endgame game
    expect(opening).toMatchObject({ id: 'u1', name: 'Caro-Kann', side: 'black', eco: 'B12', tags: ['e4'], source: 'imported', updatedAt: 5 });
    expect(opening.pgn).toBe(STUDY);
    // merged chapters name their branches after the chapter title
    expect(enumerateLines(opening).map((l) => l.name)).toEqual(['Caro main', 'Advance']);
  });

  it('garbage input is reported', () => {
    expect(parsePgnTree('hello world').errors.length).toBeGreaterThan(0);
  });
});

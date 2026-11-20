import { describe, it, expect } from 'vitest';
import { enumerateLines, indexOpening } from '../src/engine/tree';
import { buildCards, cardId } from '../src/engine/cards';
import { isAccepted } from '../src/engine/accept';
import { normalizeUci, posKey } from '../src/engine/fen';
import { opening } from './helpers';

const QGD = `[Opening "Test QGD"]
1. d4 Nf6 2. c4 { [%name Via c4] } e6 3. Nf3 b6 4. g3 Bb7 *`;
// The position after 1.d4 Nf6 2.c4 e6 3.Nf3 is also reached via 2.Nf3 e6 3.c4;
// black continues differently in the two branches.
const TRANS = `1. d4 Nf6 2. c4 (2. Nf3 { [%name Via Nf3] } e6 3. c4 d5 4. Nc3 Be7)
2... e6 3. Nf3 b6 (3... d5 4. Nc3 Be7) 4. g3 Bb7 *`;

describe('tree', () => {
  it('enumerates lines with names', () => {
    const lines = enumerateLines(opening(TRANS, 'black'));
    expect(lines.map((l) => l.nodes.map((n) => n.san).join(' '))).toEqual([
      'd4 Nf6 c4 e6 Nf3 b6 g3 Bb7',
      'd4 Nf6 c4 e6 Nf3 d5 Nc3 Be7',
      'd4 Nf6 Nf3 e6 c4 d5 Nc3 Be7',
    ]);
    expect(lines[2].name).toBe('Via Nf3');
    expect(lines[1].name).toBe('3...d5');
    expect(new Set(lines.map((l) => l.id)).size).toBe(3);
  });

  it('line ids are stable across re-parsing', () => {
    const a = enumerateLines(opening(TRANS, 'black')).map((l) => l.id);
    const b = enumerateLines(opening(TRANS, 'black')).map((l) => l.id);
    expect(a).toEqual(b);
  });

  it('keeps comments with [%name] annotations', () => {
    const o = opening(QGD, 'white');
    expect(o.root.children[0].children[0].children[0].comment).toContain('[%name Via c4]');
  });
});

describe('cards', () => {
  it('creates a card only where the learner is to move', () => {
    const white = buildCards(indexOpening(opening(QGD, 'white')));
    expect(white.map((c) => c.accepted.map((m) => m.san))).toEqual([['d4'], ['c4'], ['Nf3'], ['g3']]);
    const black = buildCards(indexOpening(opening(QGD, 'black')));
    expect(black.map((c) => c.accepted.map((m) => m.san))).toEqual([['Nf6'], ['e6'], ['b6'], ['Bb7']]);
  });

  it('merges transpositions into one card accepting all book moves', () => {
    const cards = buildCards(indexOpening(opening(TRANS, 'black')));
    const merged = cards.filter((c) => c.accepted.some((m) => m.san === 'd5'));
    expect(merged).toHaveLength(1);
    expect(merged[0].accepted.map((m) => m.san).sort()).toEqual(['b6', 'd5']);
    expect(merged[0].lineIds).toHaveLength(3);
    // ...e6 after 2.c4 and after 2.Nf3 are different positions -> two cards
    expect(cards.filter((c) => c.accepted.some((m) => m.san === 'e6'))).toHaveLength(2);
  });

  it('card ids use openingId + position key, independent of move counters', () => {
    const cards = buildCards(indexOpening(opening(TRANS, 'black', 'qgd')));
    for (const c of cards) expect(c.id).toBe(cardId('qgd', posKey(c.fen)));
    expect(posKey('8/8/8/8/8/8/8/k6K w - - 12 40')).toBe('8/8/8/8/8/8/8/k6K w - -');
  });

  it('line filter limits positions but not accepted moves', () => {
    const idx = indexOpening(opening(TRANS, 'black'));
    const only = idx.lines.find((l) => l.name === 'Via Nf3')!;
    const cards = buildCards(idx, [only.id]);
    expect(cards.map((c) => c.accepted.map((m) => m.san).sort())).toEqual([['Nf6'], ['e6'], ['b6', 'd5'], ['Be7']]);
  });
});

describe('move acceptance', () => {
  const cards = buildCards(indexOpening(opening(TRANS, 'black')));
  const card = cards.find((c) => c.accepted.length === 2)!;
  it('accepts any book move incl. transposed alternatives', () => {
    expect(isAccepted(card, 'd7d5')?.san).toBe('d5');
    expect(isAccepted(card, 'b7b6')?.san).toBe('b6');
    expect(isAccepted(card, 'c7c5')).toBeUndefined();
  });
  it('normalises king-takes-rook castling', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    expect(normalizeUci('e1h1', fen)).toBe('e1g1');
    expect(normalizeUci('e1a1', fen)).toBe('e1c1');
    expect(normalizeUci('e1f1', fen)).toBe('e1f1');
  });
});

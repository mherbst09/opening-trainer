import type { Side } from './types';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Position identity used for cards and transpositions: placement, side to move,
 * castling rights and en passant (chess.js only records en passant when a capture
 * is actually possible). Move counters are dropped.
 */
export function posKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

export function sideToMove(fen: string): Side {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

/** 32-bit FNV-1a, hex. Stable ids for lines. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Map king-onto-rook castling (e1h1) to the standard king move (e1g1). */
export function normalizeUci(uci: string, fen: string): string {
  const board = fen.split(' ')[0];
  const rows = board.split('/');
  const pieceAt = (sq: string): string | null => {
    const file = sq.charCodeAt(0) - 97;
    const rank = Number(sq[1]);
    let col = 0;
    for (const ch of rows[8 - rank]) {
      if (/\d/.test(ch)) col += Number(ch);
      else {
        if (col === file) return ch;
        col++;
      }
    }
    return null;
  };
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const p = pieceAt(from);
  const map: Record<string, string> = {
    e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8',
  };
  if ((p === 'K' || p === 'k') && map[from + to]) {
    const target = pieceAt(to);
    if (target === (p === 'K' ? 'R' : 'r')) return map[from + to];
  }
  return uci;
}

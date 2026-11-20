import { posKey, sideToMove } from './fen';
import { stripAnnotations } from '../content/pgnTree';
import type { OpeningIndex } from './tree';
import type { AcceptedMove, Card, CardProgress } from './types';

export const cardId = (openingId: string, key: string) => `${openingId}|${key}`;

/**
 * One card per position (posKey) where the learner is to move and the book has at
 * least one move. Accepted moves are the union of book moves over every tree node
 * reaching that position, so transpositions and alternative book moves count.
 * `lineFilter` restricts which positions become cards, never which moves are accepted.
 */
export function buildCards(index: OpeningIndex, lineFilter?: string[]): Card[] {
  const { opening } = index;
  const allowed = lineFilter && lineFilter.length ? new Set(lineFilter) : null;
  const cards = new Map<string, Card>();
  const order: string[] = [];

  // breadth-first so earlier positions come first in "new" queues
  const queue = [opening.root];
  while (queue.length) {
    const node = queue.shift()!;
    queue.push(...node.children);
    if (!node.children.length || sideToMove(node.fen) !== opening.side) continue;
    const through = index.linesThrough.get(node.id) ?? [];
    const relevant = allowed ? through.filter((id) => allowed.has(id)) : through;
    if (!relevant.length) continue;
    const key = posKey(node.fen);
    const id = cardId(opening.id, key);
    if (cards.has(id)) continue;

    const accepted = new Map<string, AcceptedMove>();
    const lineIds = new Set<string>();
    let comment: string | undefined;
    for (const twin of index.byPos.get(key) ?? []) {
      for (const child of twin.children) {
        if (!accepted.has(child.uci)) accepted.set(child.uci, { uci: child.uci, san: child.san });
        if (!comment && child.comment) {
          const c = stripAnnotations(child.comment);
          if (c) comment = c;
        }
      }
      for (const l of index.linesThrough.get(twin.id) ?? []) {
        if (!allowed || allowed.has(l)) lineIds.add(l);
      }
    }
    cards.set(id, {
      id,
      openingId: opening.id,
      posKey: key,
      fen: node.fen,
      accepted: [...accepted.values()],
      lineIds: [...lineIds],
      comment,
    });
    order.push(id);
  }
  return order.map((id) => cards.get(id)!);
}

export function attachProgress(cards: Card[], progress: Map<string, CardProgress>): Card[] {
  return cards.map((c) => {
    const p = progress.get(c.id);
    return p ? { ...c, srs: p.srs } : c;
  });
}

/** Comment for a specific accepted move at a card position (falls back to card comment). */
export function commentFor(index: OpeningIndex, card: Card, uci: string): string | undefined {
  for (const twin of index.byPos.get(card.posKey) ?? []) {
    const child = twin.children.find((c) => c.uci === uci);
    if (child?.comment) {
      const c = stripAnnotations(child.comment);
      if (c) return c;
    }
  }
  return undefined;
}

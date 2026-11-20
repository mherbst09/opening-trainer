import { normalizeUci } from './fen';
import type { AcceptedMove, Card } from './types';

export function isAccepted(card: Card, uci: string): AcceptedMove | undefined {
  const u = normalizeUci(uci, card.fen);
  return card.accepted.find((m) => m.uci === u);
}

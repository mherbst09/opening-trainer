// Choosing which openings / variations a quiz covers. Pure, UI-independent.
import type { OpeningIndex } from './tree';
import type { Opening, Side } from './types';

export interface OpeningFilter {
  query: string;
  side: 'all' | Side;
  ecoFamilies: string[]; // 'A'..'E'; empty = any
  tags: string[]; // opening must have ALL of these; empty = any
}

export const EMPTY_FILTER: OpeningFilter = { query: '', side: 'all', ecoFamilies: [], tags: [] };
export const ECO_FAMILIES = ['A', 'B', 'C', 'D', 'E'] as const;
export const ECO_FAMILY_LABEL: Record<string, string> = {
  A: 'A · Flank',
  B: 'B · Semi-open',
  C: 'C · Open / French',
  D: 'D · Closed',
  E: 'E · Indian',
};

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

export function matchesFilter(o: Opening, f: OpeningFilter): boolean {
  if (f.side !== 'all' && o.side !== f.side) return false;
  if (f.ecoFamilies.length && !f.ecoFamilies.includes(o.eco.charAt(0).toUpperCase())) return false;
  if (f.tags.length && !f.tags.every((t) => o.tags.includes(t))) return false;
  const words = norm(f.query).split(/\s+/).filter(Boolean);
  if (words.length) {
    const hay = norm([o.name, o.eco, ...o.tags].join(' '));
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

export function allTags(openings: Opening[]): string[] {
  return [...new Set(openings.flatMap((o) => o.tags))].sort();
}

export interface Selection {
  openingIds: string[];
  /** openingId -> selected lineIds; missing or empty = whole opening */
  lineFilter: Record<string, string[]>;
}

export const EMPTY_SELECTION: Selection = { openingIds: [], lineFilter: {} };

/** Drop openings and lines that no longer exist (deleted imports, edited content). */
export function cleanSelection(sel: Selection, indexes: Map<string, OpeningIndex>): Selection {
  const openingIds = sel.openingIds.filter((id) => indexes.has(id));
  const lineFilter: Record<string, string[]> = {};
  for (const id of openingIds) {
    const wanted = sel.lineFilter[id];
    if (!wanted?.length) continue;
    const known = new Set(indexes.get(id)!.lines.map((l) => l.id));
    const kept = wanted.filter((l) => known.has(l));
    // all lines selected (or none left) == whole opening
    if (kept.length && kept.length < known.size) lineFilter[id] = kept;
  }
  return { openingIds, lineFilter };
}

export function toggleOpening(sel: Selection, id: string, on: boolean): Selection {
  const has = sel.openingIds.includes(id);
  if (on === has) return sel;
  if (on) return { ...sel, openingIds: [...sel.openingIds, id] };
  const { [id]: _drop, ...rest } = sel.lineFilter;
  void _drop;
  return { openingIds: sel.openingIds.filter((x) => x !== id), lineFilter: rest };
}

/** Toggle one variation; `allLineIds` are the opening's lines. Selecting a line selects its opening. */
export function toggleLine(sel: Selection, openingId: string, lineId: string, allLineIds: string[], on: boolean): Selection {
  const current = sel.lineFilter[openingId]?.length ? sel.lineFilter[openingId] : allLineIds;
  const next = on ? [...new Set([...current, lineId])] : current.filter((l) => l !== lineId);
  const withOpening = toggleOpening(sel, openingId, true);
  if (!next.length) return toggleOpening(sel, openingId, false);
  const lineFilter = { ...withOpening.lineFilter };
  if (next.length === allLineIds.length) delete lineFilter[openingId];
  else lineFilter[openingId] = allLineIds.filter((l) => next.includes(l));
  return { ...withOpening, lineFilter };
}

export type QuizModeParam = 'next-move' | 'line';
export type QueueParam = 'due' | 'all';

/** URL params understood by the quiz route. */
export function selectionToParams(sel: Selection, mode: QuizModeParam, queue: QueueParam): Record<string, string> {
  const p: Record<string, string> = { o: sel.openingIds.join(','), q: queue };
  const lines = sel.openingIds.flatMap((id) => sel.lineFilter[id] ?? []);
  if (lines.length) p.l = lines.join(',');
  if (mode === 'line') p.m = 'line';
  return p;
}

// Session setup and persistence shared by both quiz modes.
import { useEffect, useRef, useState } from 'react';
import { repo } from '../db/repo';
import type { Grade } from '../engine/scheduler';
import { shouldRecord } from '../engine/recordPolicy';
import type { Outcome, QuizContext } from '../engine/quiz';
import type { Card, QuizMode, Settings } from '../engine/types';
import { useAppData } from './data';

export type QueueKind = 'due' | 'all';

export interface SessionBase {
  ctx: QuizContext;
  kind: QueueKind;
  openingIds: string[];
  lineFilter: Record<string, string[]>;
  cards: Card[];
  newBudget: number;
}

/** Parse ?o=ids&l=lineIds&q=due|all once data is loaded. */
export function useSessionBase(params: URLSearchParams): SessionBase | null {
  const data = useAppData();
  const [base, setBase] = useState<SessionBase | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!data.loaded || started.current) return;
    started.current = true;
    void (async () => {
      const kind: QueueKind = params.get('q') === 'all' ? 'all' : 'due';
      const openingIds = (params.get('o') ?? '').split(',').filter((id) => data.indexes.has(id));
      const wanted = new Set((params.get('l') ?? '').split(',').filter(Boolean));
      const lineFilter: Record<string, string[]> = {};
      if (wanted.size) {
        for (const id of openingIds) {
          const ls = data.indexes.get(id)!.lines.filter((l) => wanted.has(l.id)).map((l) => l.id);
          if (ls.length) lineFilter[id] = ls;
        }
      }
      const cards = openingIds.flatMap((id) => data.cardsFor(id, lineFilter[id]));
      const used = await repo.newCardsReviewedToday();
      setBase({
        kind,
        openingIds,
        lineFilter,
        cards,
        newBudget: Math.max(0, data.settings.newCardsPerDay - used),
        ctx: {
          cards: new Map(cards.map((c) => [c.id, c])),
          indexes: data.indexes,
          lineFilter,
          requeueLapses: kind === 'due',
          rng: Math.random,
        },
      });
    })();
  }, [data, params]);

  return base;
}

/** Persist answers according to the engine's record policy (see recordPolicy.ts). */
export function usePersister(base: SessionBase | null, settings: Settings, mode: QuizMode, oncePerSession: boolean) {
  const graded = useRef(new Map<string, Grade>());
  return async (outcome: Outcome | undefined) => {
    if (!outcome || !base) return;
    const card = base.ctx.cards.get(outcome.cardId);
    if (!card) return;
    const record = shouldRecord({
      card,
      grade: outcome.grade,
      now: Date.now(),
      queue: base.kind,
      countPracticeReviews: settings.countPracticeReviews,
      previous: graded.current.get(card.id),
      oncePerSession,
    });
    if (!record) return;
    graded.current.set(card.id, outcome.grade);
    const p = await repo.recordReview(card, outcome.grade, mode);
    base.ctx.cards.set(card.id, { ...card, srs: p.srs });
  };
}

/** "Still due" and "next due" across the session's openings. */
export function DueStats({ openingIds }: { openingIds: string[] }) {
  const data = useAppData();
  const now = Date.now();
  let nextDue: number | undefined;
  let dueNow = 0;
  for (const id of openingIds) {
    for (const c of data.cardsFor(id)) {
      if (!c.srs) continue;
      if (c.srs.dueAt <= now) dueNow++;
      else if (nextDue === undefined || c.srs.dueAt < nextDue) nextDue = c.srs.dueAt;
    }
  }
  return (
    <>
      <div><dt>Still due</dt><dd>{dueNow}</dd></div>
      <div><dt>Next due</dt><dd className="small-dd">{nextDue ? formatWhen(nextDue, now) : '—'}</dd></div>
    </>
  );
}

export function formatWhen(t: number, now = Date.now()): string {
  const min = Math.round((t - now) / 60_000);
  if (min < 60) return `in ${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `in ${h} h`;
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

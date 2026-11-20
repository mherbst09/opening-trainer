import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { loadBuiltinOpenings } from '../content/loader';
import { repo, onLocalChange } from '../db/repo';
import { DEFAULT_SETTINGS } from '../db/db';
import { attachProgress, buildCards } from '../engine/cards';
import { cardStatus, type CardStatus } from '../engine/scheduler';
import { indexOpening, type OpeningIndex } from '../engine/tree';
import type { Card, CardProgress, Opening, Settings, StudySet } from '../engine/types';

interface AppData {
  loaded: boolean;
  openings: Opening[];
  indexes: Map<string, OpeningIndex>;
  progress: Map<string, CardProgress>;
  settings: Settings;
  sets: StudySet[];
  /** Cards (with progress) for an opening, optionally narrowed to lines. */
  cardsFor(openingId: string, lineIds?: string[]): Card[];
  counts(openingId: string, now?: number): Record<CardStatus, number>;
  refresh(): Promise<void>;
}

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const builtin = useMemo(() => loadBuiltinOpenings(), []);
  const [imported, setImported] = useState<Opening[]>([]);
  const [progress, setProgress] = useState<Map<string, CardProgress>>(new Map());
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [sets, setSets] = useState<StudySet[]>([]);
  const [loaded, setLoaded] = useState(false);

  const openings = useMemo(
    () => [...builtin, ...imported].sort((a, b) => a.name.localeCompare(b.name)),
    [builtin, imported],
  );
  const indexes = useMemo(() => new Map(openings.map((o) => [o.id, indexOpening(o)])), [openings]);
  const baseCards = useMemo(() => new Map<string, Card[]>(), [indexes]);

  const refresh = useCallback(async () => {
    const [p, s, st, imp] = await Promise.all([repo.progressMap(), repo.settings(), repo.sets(), repo.importedOpenings()]);
    // Re-index only when imported openings actually changed (refresh runs after every review).
    const sig = (list: Opening[]) => list.map((o) => `${o.id}@${o.updatedAt}`).join('|');
    setImported((prev) => (sig(prev) === sig(imp) ? prev : imp));
    setSets(st);
    setProgress(p);
    setSettings(s);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    return onLocalChange(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === 'system') delete el.dataset.theme;
    else el.dataset.theme = settings.theme;
  }, [settings.theme]);

  const value = useMemo<AppData>(() => {
    const cardsFor = (openingId: string, lineIds?: string[]) => {
      const index = indexes.get(openingId);
      if (!index) return [];
      if (lineIds?.length) return attachProgress(buildCards(index, lineIds), progress);
      let base = baseCards.get(openingId);
      if (!base) {
        base = buildCards(index);
        baseCards.set(openingId, base);
      }
      return attachProgress(base, progress);
    };
    const counts = (openingId: string, now = Date.now()) => {
      const c: Record<CardStatus, number> = { new: 0, learning: 0, due: 0, learned: 0 };
      for (const card of cardsFor(openingId)) c[cardStatus(card, now)]++;
      return c;
    };
    return { loaded, openings, indexes, progress, settings, sets, cardsFor, counts, refresh };
  }, [loaded, openings, indexes, progress, settings, sets, baseCards, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppData outside provider');
  return v;
}

import Dexie, { type EntityTable } from 'dexie';
import type { CardProgress, Opening, ReviewLogEntry, Settings, StudySet } from '../engine/types';

export interface MetaRow {
  key: string;
  value: unknown;
}

export class TrainerDB extends Dexie {
  progress!: EntityTable<CardProgress, 'id'>;
  reviewLogs!: EntityTable<ReviewLogEntry, 'id'>;
  sets!: EntityTable<StudySet, 'id'>;
  openings!: EntityTable<Opening, 'id'>; // imported openings only
  meta!: EntityTable<MetaRow, 'key'>; // settings, deviceId, sync state, tokens

  constructor(name = 'opening-trainer') {
    super(name);
    this.version(1).stores({
      progress: 'id, openingId, srs.dueAt, updatedAt',
      reviewLogs: 'id, cardId, at',
      sets: 'id, updatedAt',
      openings: 'id, updatedAt',
      meta: 'key',
    });
  }
}

export const db = new TrainerDB();

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  stopAtFirstMistake: false,
  newCardsPerDay: 20,
  countPracticeReviews: false,
  updatedAt: 0,
};

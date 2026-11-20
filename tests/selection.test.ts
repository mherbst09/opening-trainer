import { describe, it, expect } from 'vitest';
import {
  allTags, cleanSelection, EMPTY_FILTER, EMPTY_SELECTION, matchesFilter, selectionToParams, toggleLine, toggleOpening,
} from '../src/engine/selection';
import { indexOpening } from '../src/engine/tree';
import type { Opening } from '../src/engine/types';
import { opening } from './helpers';

function o(id: string, name: string, eco: string, side: 'white' | 'black', tags: string[]): Opening {
  return { ...opening('1. e4 e5 *', side, id), name, eco, tags };
}

const italian = o('italian', 'Italian Game', 'C50', 'white', ['e4', 'open']);
const najdorf = o('najdorf', 'Sicilian Najdorf', 'B90', 'black', ['e4', 'sharp']);
const kid = o('kid', "King's Indian Défense", 'E60', 'black', ['d4', 'sharp']);
const all = [italian, najdorf, kid];
const pick = (f: Partial<typeof EMPTY_FILTER>) => all.filter((x) => matchesFilter(x, { ...EMPTY_FILTER, ...f })).map((x) => x.id);

describe('opening filter', () => {
  it('matches by side, ECO family, tags (all) and search words', () => {
    expect(pick({})).toEqual(['italian', 'najdorf', 'kid']);
    expect(pick({ side: 'black' })).toEqual(['najdorf', 'kid']);
    expect(pick({ ecoFamilies: ['B', 'C'] })).toEqual(['italian', 'najdorf']);
    expect(pick({ tags: ['sharp'] })).toEqual(['najdorf', 'kid']);
    expect(pick({ tags: ['sharp', 'd4'] })).toEqual(['kid']);
    expect(pick({ query: 'sicil' })).toEqual(['najdorf']);
    expect(pick({ query: 'b90' })).toEqual(['najdorf']);
    expect(pick({ query: 'indian defense' })).toEqual(['kid']); // accents ignored
    expect(pick({ query: 'italian sharp' })).toEqual([]);
  });
  it('collects tags', () => {
    expect(allTags(all)).toEqual(['d4', 'e4', 'open', 'sharp']);
  });
});

const BRANCHY = `1. e4 e5 2. Nf3 (2. Bc4 Nf6) (2. f4 exf4) 2... Nc6 *`;

describe('selection', () => {
  const idx = indexOpening(opening(BRANCHY, 'white', 'x'));
  const lineIds = idx.lines.map((l) => l.id);
  const indexes = new Map([['x', idx]]);

  it('toggles openings and drops their line filter', () => {
    let s = toggleOpening(EMPTY_SELECTION, 'x', true);
    expect(s.openingIds).toEqual(['x']);
    s = toggleLine(s, 'x', lineIds[1], lineIds, false);
    expect(s.lineFilter.x).toEqual([lineIds[0], lineIds[2]]);
    s = toggleOpening(s, 'x', false);
    expect(s).toEqual(EMPTY_SELECTION);
  });

  it('selecting all lines again clears the filter; deselecting the last line drops the opening', () => {
    let s = toggleLine(EMPTY_SELECTION, 'x', lineIds[0], lineIds, false); // opening not selected yet -> selects others
    expect(s.openingIds).toEqual(['x']);
    expect(s.lineFilter.x).toEqual([lineIds[1], lineIds[2]]);
    s = toggleLine(s, 'x', lineIds[0], lineIds, true);
    expect(s.lineFilter.x).toBeUndefined();
    s = toggleLine(toggleLine(s, 'x', lineIds[0], lineIds, false), 'x', lineIds[1], lineIds, false);
    expect(s.lineFilter.x).toEqual([lineIds[2]]);
    s = toggleLine(s, 'x', lineIds[2], lineIds, false);
    expect(s.openingIds).toEqual([]);
  });

  it('cleans unknown openings/lines and builds quiz params', () => {
    const dirty = { openingIds: ['x', 'gone'], lineFilter: { x: [lineIds[1], 'old'], gone: ['z'] } };
    const clean = cleanSelection(dirty, indexes);
    expect(clean).toEqual({ openingIds: ['x'], lineFilter: { x: [lineIds[1]] } });
    expect(selectionToParams(clean, 'line', 'due')).toEqual({ o: 'x', q: 'due', l: lineIds[1], m: 'line' });
    expect(selectionToParams({ openingIds: ['x'], lineFilter: {} }, 'next-move', 'all')).toEqual({ o: 'x', q: 'all' });
  });
});

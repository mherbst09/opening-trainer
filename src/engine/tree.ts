import { extractName } from '../content/pgnTree';
import { fnv1a, posKey } from './fen';
import type { Line, Opening, TreeNode } from './types';

export function moveNumberLabel(fen: string): string {
  // label for the move that led TO this fen is computed by caller; this returns prefix for next move
  const [, turn, , , , full] = fen.split(' ');
  return turn === 'w' ? `${full}.` : `${full}...`;
}

/** SAN with move number, e.g. "5.d4" or "5...exd4", for a node given its parent's FEN. */
export function formatMove(parentFen: string, san: string): string {
  return `${moveNumberLabel(parentFen)}${san}`;
}

/** All root-to-leaf lines in tree order (main line first). */
export function enumerateLines(opening: Opening): Line[] {
  const lines: Line[] = [];
  const walk = (node: TreeNode, path: TreeNode[], name: string | undefined, parentFen: string, branchLabel: string | undefined) => {
    if (!node.children.length) {
      const sans = path.map((n) => n.san).join(' ');
      lines.push({
        id: fnv1a(`${opening.id}|${sans}`),
        openingId: opening.id,
        name: name ?? branchLabel ?? 'Main line',
        nodes: path,
      });
      return;
    }
    node.children.forEach((child, i) => {
      const childName = extractName(child.comment) ?? name;
      // fallback label: the most recent move where this line left the main branch
      const label = i > 0 ? formatMove(node.fen, child.san) : branchLabel;
      walk(child, [...path, child], childName, node.fen, label);
    });
    void parentFen;
  };
  walk(opening.root, [], undefined, opening.root.fen, undefined);
  // de-duplicate names
  const seen = new Map<string, number>();
  for (const l of lines) {
    const n = (seen.get(l.name) ?? 0) + 1;
    seen.set(l.name, n);
    if (n > 1) l.name = `${l.name} (${n})`;
  }
  return lines;
}

export interface OpeningIndex {
  opening: Opening;
  lines: Line[];
  byId: Map<string, TreeNode>;
  parentOf: Map<string, TreeNode>;
  /** posKey -> every node (incl. root) reaching that position */
  byPos: Map<string, TreeNode[]>;
  /** node id -> ids of lines passing through it */
  linesThrough: Map<string, string[]>;
}

export function indexOpening(opening: Opening): OpeningIndex {
  const byId = new Map<string, TreeNode>();
  const parentOf = new Map<string, TreeNode>();
  const byPos = new Map<string, TreeNode[]>();
  const visit = (node: TreeNode) => {
    byId.set(node.id, node);
    const k = posKey(node.fen);
    const list = byPos.get(k);
    if (list) list.push(node);
    else byPos.set(k, [node]);
    for (const c of node.children) {
      parentOf.set(c.id, node);
      visit(c);
    }
  };
  visit(opening.root);
  const lines = enumerateLines(opening);
  const linesThrough = new Map<string, string[]>();
  linesThrough.set('', lines.map((l) => l.id));
  for (const line of lines) {
    for (const n of line.nodes) {
      const arr = linesThrough.get(n.id);
      if (arr) arr.push(line.id);
      else linesThrough.set(n.id, [line.id]);
    }
  }
  return { opening, lines, byId, parentOf, byPos, linesThrough };
}

/** Path from root (exclusive) to the given node. */
export function pathTo(index: OpeningIndex, nodeId: string): TreeNode[] {
  const out: TreeNode[] = [];
  let n = index.byId.get(nodeId);
  while (n && n.id !== '') {
    out.unshift(n);
    n = index.parentOf.get(n.id);
  }
  return out;
}

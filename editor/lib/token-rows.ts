import type { DocumentGraph, TokenEntry } from '../../lib/document.ts';
import { tokenDisplayName } from './value-shape.ts';

const searchText = new WeakMap<TokenEntry, readonly string[]>();
const rowIndices = new WeakMap<DocumentGraph, ReadonlyMap<string, number>>();

export function tokenRowIndex(graph: DocumentGraph, path: string) {
  let indices = rowIndices.get(graph);
  if (!indices) {
    indices = new Map(graph.rows.map(([id], index) => [id, index]));
    rowIndices.set(graph, indices);
  }
  return indices.get(path) ?? -1;
}

export function queryTokenRows(graph: DocumentGraph, start: number, end: number, query: string,
  issues?: ReadonlyMap<string, string>) {
  const rows: DocumentGraph['rows'] = [];
  for (let index = start; index < end; index++) {
    const row = graph.rows[index];
    if (!row || issues && !issues.has(row[0])) continue;
    if (query) {
      const [path, token] = row;
      let fields = searchText.get(token);
      if (!fields) {
        fields = [path, tokenDisplayName(path), token.type, token.node.$description]
          .flatMap(value => typeof value === 'string' ? [value.toLowerCase()] : []);
        searchText.set(token, fields);
      }
      if (!fields.some(field => field.includes(query))) continue;
    }
    rows.push(row);
  }
  return rows;
}

function lowerBound(values: readonly number[], target: number) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((values[mid] ?? Infinity) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const issueIndices = new WeakMap<DocumentGraph, WeakMap<ReadonlyMap<string, string>, readonly number[]>>();

export function countTokenIssues(graph: DocumentGraph, issues: ReadonlyMap<string, string>, start: number, end: number) {
  if (!issues.size) return 0;
  let byIssueGraph = issueIndices.get(graph);
  if (!byIssueGraph) {
    byIssueGraph = new WeakMap();
    issueIndices.set(graph, byIssueGraph);
  }
  let positions = byIssueGraph.get(issues);
  if (!positions) {
    positions = [...issues.keys()].map(path => tokenRowIndex(graph, path)).filter(index => index >= 0).toSorted((a, b) => a - b);
    byIssueGraph.set(issues, positions);
  }
  return lowerBound(positions, end) - lowerBound(positions, start);
}

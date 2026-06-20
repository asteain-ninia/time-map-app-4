// Property tests for deterministic four-color assignment (受け入れ基準2 / 6).
//
// Invariants over ARBITRARY adjacency graphs:
//   1. no two adjacent colorable nodes share a color index (隣接同色ゼロ),
//   2. the assignment is deterministic (re-running yields the identical map),
//   3. assignColorIndices does not mutate the input graph.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { adjacencySignature } from './adjacency';
import { assignColorIndices, findColorConflicts } from './four-color';
import { adjacencyGraphArb, colorableSubsetArb } from './coloring.arbitraries';

describe('four-color (property)', () => {
  it('adjacent colorable nodes never share a color index', () => {
    fc.assert(
      fc.property(
        adjacencyGraphArb().chain((spec) =>
          colorableSubsetArb(spec).map((colorable) => ({ spec, colorable })),
        ),
        ({ spec, colorable }) => {
          const assignment = assignColorIndices(spec.graph, colorable);
          // every colorable node gets exactly one index
          for (const id of colorable) {
            expect(assignment.has(id)).toBe(true);
          }
          // no conflicts among the colored nodes
          expect(findColorConflicts(spec.graph, assignment)).toHaveLength(0);
        },
      ),
    );
  });

  it('is deterministic and does not mutate the graph', () => {
    fc.assert(
      fc.property(
        adjacencyGraphArb().chain((spec) =>
          colorableSubsetArb(spec).map((colorable) => ({ spec, colorable })),
        ),
        ({ spec, colorable }) => {
          const sigBefore = adjacencySignature(spec.graph);
          const a1 = assignColorIndices(spec.graph, colorable);
          const a2 = assignColorIndices(spec.graph, colorable);
          expect([...a1.entries()]).toEqual([...a2.entries()]);
          // input graph signature unchanged (no mutation).
          expect(adjacencySignature(spec.graph)).toBe(sigBefore);
        },
      ),
    );
  });
});

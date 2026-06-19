// fast-check arbitraries for the U11 shared-vertex property tests. Generates
// SharedVertexStates with a mix of unshared and shared vertices across rings
// and line paths so the前後比較 invariants (受け入れ基準 5) can be exercised.

import fc from 'fast-check';

import { createCoordinate, type WorldCoordinate } from './coordinate';
import { asFeatureId, asVertexId, type FeatureId, type VertexId } from './ids';
import {
  createSharedVertexState,
  type ContainerEntry,
  type ShapeContainer,
  type SharedVertexState,
} from './shared-vertex';
import { createVertex, createVertexStore, type Vertex } from './vertex';

const coordinateArb: fc.Arbitrary<WorldCoordinate> = fc
  .tuple(
    fc.integer({ min: -170, max: 170 }),
    fc.integer({ min: -80, max: 80 }),
  )
  .map(([lon, lat]) => createCoordinate(lon, lat));

/**
 * Generate a state with `vertexCount` distinct vertices and a handful of
 * containers (rings / line paths) each citing a subset, with at least one
 * vertex shared across two containers when possible.
 */
export const sharedVertexStateArb: fc.Arbitrary<SharedVertexState> = fc
  .record({
    vertexCount: fc.integer({ min: 3, max: 8 }),
    ringCount: fc.integer({ min: 1, max: 3 }),
  })
  .chain(({ vertexCount, ringCount }) => {
    const coords = fc.array(coordinateArb, {
      minLength: vertexCount,
      maxLength: vertexCount,
    });
    return coords.map((coordList) => {
      // Spread coordinates apart so no two are accidentally coincident (avoids
      // spurious zero-length edges in the structural invariants we assert).
      const vertices: Vertex[] = coordList.map((c, i) =>
        createVertex(asVertexId(`v${i}`), createCoordinate(c.lon + i * 0.5, c.lat)),
      );
      const ids = vertices.map((v) => v.id);

      const containers: ContainerEntry[] = [];
      for (let r = 0; r < ringCount; r += 1) {
        const featureId = asFeatureId(`f${r}`);
        const container: ShapeContainer = {
          kind: 'ring',
          featureId,
          ringId: `ring${r}`,
        };
        // Each ring cites 3 distinct vertices (a minimal triangle), offset so
        // adjacent rings overlap by one vertex => shared vertices appear.
        const start = r % Math.max(1, ids.length - 2);
        const v0 = ids[start];
        const v1 = ids[(start + 1) % ids.length];
        const v2 = ids[(start + 2) % ids.length];
        if (v0 === undefined || v1 === undefined || v2 === undefined) continue;
        // Skip rings that would cite the same vertex twice (same-ring conflict).
        const set = new Set([v0, v1, v2]);
        if (set.size < 3) continue;
        containers.push({ container, vertexIds: [v0, v1, v2] });
      }

      return createSharedVertexState(createVertexStore(vertices), containers);
    });
  });

export { coordinateArb };
export type { FeatureId, VertexId };

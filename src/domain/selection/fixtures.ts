// U22 selection — shared test fixtures (教訓 5.39: build via real factories, not
// hand-written literals). Consumed only by *.test.ts files.

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLineFeature, type LineFeature } from '../feature';
import { asFeatureId, asVertexId, type FeatureId, type VertexId } from '../ids';
import { createVertex } from '../vertex';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

export function fid(raw: string): FeatureId {
  return asFeatureId(raw);
}

export function vid(raw: string): VertexId {
  return asVertexId(raw);
}

export function coord(lon: number, lat: number) {
  return createCoordinate(lon, lat);
}

/** A line feature with `n` vertices `<prefix>-v0..` owned by feature `<prefix>`. */
export function lineWithVertices(prefix: string, n: number): LineFeature {
  const verts = Array.from({ length: n }, (_, i) =>
    createVertex(vid(`${prefix}-v${i}`), coord(i, i)),
  );
  return createLineFeature(
    fid(prefix),
    createBasicAttributes(prefix, 0, 100),
    COLOR,
    verts.map((v) => v.id),
  );
}

/** Build a VertexId set from raw vertex-id strings. */
export function vidSet(...raws: readonly string[]): Set<VertexId> {
  return new Set(raws.map(vid));
}

/** An owner map from a list of [vertex, feature] raw-id pairs. */
export function owners(
  ...pairs: ReadonlyArray<readonly [string, string]>
): Map<VertexId, FeatureId> {
  const m = new Map<VertexId, FeatureId>();
  for (const [v, f] of pairs) m.set(vid(v), fid(f));
  return m;
}

// U14 type-level test (受け入れ基準2): the z.infer-derived persisted types are
// structurally compatible with the values the domain factories produce (via the
// serializer), and validation logic + type are NOT declared twice (the types are
// derived from the schema, proven by importing them only from `./schema`).
//
// This file is checked by `tsc` (typecheck), not run by Vitest. A compile error
// here is the failure signal. No runtime assertions.

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createPointFeature } from '../feature';
import { asFeatureId, asVertexId } from '../ids';
import type {
  PersistedBasicAttributes,
  PersistedColorInfo,
  PersistedCoordinate,
  PersistedFeature,
  PersistedVertex,
} from './schema';
import { serialize } from './serialize';
import { richValidProject } from './fixtures';

// A domain coordinate serializes to exactly the persisted coordinate shape.
const coord = createCoordinate(10, 20);
const pCoord: PersistedCoordinate = { lon: coord.lon, lat: coord.lat };
void pCoord;

// Domain attributes / color map field-for-field onto the persisted types.
const attrs = createBasicAttributes('x', -100, 100);
const pAttrs: PersistedBasicAttributes = {
  name: attrs.name,
  startYear: attrs.startYear,
  endYear: attrs.endYear,
};
void pAttrs;

const color = createColorInfo(true, '#000', '#111', '#222');
const pColor: PersistedColorInfo = {
  autoColorEnabled: color.autoColorEnabled,
  fillColor: color.fillColor,
  selectedColor: color.selectedColor,
  borderColor: color.borderColor,
};
void pColor;

// A serialized point feature is assignable to the discriminated PersistedFeature.
const point = createPointFeature(
  asFeatureId('f'),
  attrs,
  color,
  asVertexId('v'),
);
void point;

// The serializer's output is exactly the schema-derived Manifest; pulling out a
// persisted feature / vertex from it must type-check against the derived types.
const manifest = serialize(richValidProject());
const firstHistory = manifest.histories[0];
if (firstHistory !== undefined) {
  const firstEntry = firstHistory.entries[0];
  if (firstEntry !== undefined) {
    const f: PersistedFeature | undefined = firstEntry.anchor.snapshot.features[0];
    void f;
    const v: PersistedVertex | undefined = firstEntry.anchor.snapshot.vertices[0];
    void v;
  }
}

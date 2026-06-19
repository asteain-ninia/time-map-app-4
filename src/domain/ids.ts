// Nominal (branded) ID types for the domain.
//
// Each ID is a `string` carrying a unique phantom brand. Branded types are
// structurally distinct from a bare `string` and from one another, so the
// compiler rejects passing a VertexId where a FeatureId is expected, or a
// raw string where any ID is expected. This makes ID mix-ups a compile-time
// error (lesson 5.19: branch/identity values go through type definitions,
// not bare strings).
//
// The brand lives only in the type system (`declare const ... unique symbol`)
// and has no runtime footprint: at runtime every ID is just a string, which
// keeps the model trivially mappable to/from plain data (lesson 5.20 / 5.31).

declare const VertexIdBrand: unique symbol;
declare const FeatureIdBrand: unique symbol;
declare const RingIdBrand: unique symbol;
declare const AnchorIdBrand: unique symbol;
declare const SharedVertexGroupIdBrand: unique symbol;

/** Identifies a vertex value object within the vertex store. */
export type VertexId = string & { readonly [VertexIdBrand]: 'VertexId' };

/** Identifies a feature (point / line / leaf / aggregate). */
export type FeatureId = string & { readonly [FeatureIdBrand]: 'FeatureId' };

/** Identifies a ring (territory / hole). */
export type RingId = string & { readonly [RingIdBrand]: 'RingId' };

/** Identifies a history anchor (full-state snapshot). */
export type AnchorId = string & { readonly [AnchorIdBrand]: 'AnchorId' };

/** Identifies a group of vertices that are intended to be shared/merged. */
export type SharedVertexGroupId = string & {
  readonly [SharedVertexGroupIdBrand]: 'SharedVertexGroupId';
};

/** Union of every branded ID kind defined in the domain. */
export type DomainId =
  | VertexId
  | FeatureId
  | RingId
  | AnchorId
  | SharedVertexGroupId;

// --- Constructors -----------------------------------------------------------
//
// Construction goes through explicit factories rather than `as` casts spread
// across the codebase, so the (single) place that mints branded IDs is auditable.
// Callers that already hold a validated raw string (e.g. when rehydrating from
// persisted plain data) use these to re-attach the brand.

export function asVertexId(raw: string): VertexId {
  return raw as VertexId;
}

export function asFeatureId(raw: string): FeatureId {
  return raw as FeatureId;
}

export function asRingId(raw: string): RingId {
  return raw as RingId;
}

export function asAnchorId(raw: string): AnchorId {
  return raw as AnchorId;
}

export function asSharedVertexGroupId(raw: string): SharedVertexGroupId {
  return raw as SharedVertexGroupId;
}

/** Strip the brand back to a plain string (for serialization / logging). */
export function idToString(id: DomainId): string {
  return id;
}

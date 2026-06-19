// Preset 出界図 (base-map) reference + the displayed-base-map selection (U18 /
// FR-03). Domain layer: pure, framework-free.
//
// SCOPE (spec §プリセット出界図 FR-03):
//   - the stable identity of the bundled preset 出界図 (an in-app asset, loaded
//     offline; the actual image bytes are bundled by the build / loaded by the
//     render adapter — this module only names the reference and its equirectangular
//     meta),
//   - the resolution of WHICH base-map is currently displayed given a project's
//     base-map reference, so the three preset-display triggers (初回起動 / 新規 /
//     読込失敗) all funnel through ONE decision (受け入れ基準 1, 教訓 5.29).
//
// WHAT THIS MODULE DOES NOT DO (spec §やらないこと):
//   - it does not decode / draw the image, nor read the ZIP. It carries a
//     reference + equirectangular meta; the render adapter resolves the reference
//     to a paintable image.

/**
 * The bundled preset 出界図 reference id (spec FR-03 同梱アセット). A reserved,
 * non-empty sentinel distinct from any user source string, so a project that
 * stores this id is understood to use the preset. Loaded offline from the app
 * bundle (FR-02 / FR-03); the render adapter maps this id to the bundled asset.
 */
export const PRESET_BASEMAP_ID = '@preset/equirectangular-world' as const;

/**
 * Equirectangular meta for any base-map (spec §正距円筒メタ): the world rectangle
 * the image is pasted onto. The preset spans the full world (−180..180 lon,
 * −90..90 lat); a 2:1 image fills it exactly (受け入れ基準 2). These are the world
 * bounds the render layer hands to the `BaseMapPrimitive`.
 */
export interface EquirectangularMeta {
  readonly lonWest: number;
  readonly lonEast: number;
  readonly latNorth: number;
  readonly latSouth: number;
}

/** The full-world equirectangular meta (the only valid placement for a 2:1 map). */
export const FULL_WORLD_META: EquirectangularMeta = {
  lonWest: -180,
  lonEast: 180,
  latNorth: 90,
  latSouth: -90,
};

/**
 * Which base-map kind is currently displayed. `Preset` covers the three triggers
 * (初回起動 / 新規 / 読込失敗); `User` is an adopted (possibly corrected) map.
 */
export const DISPLAYED_BASEMAP = {
  Preset: 'preset',
  User: 'user',
} as const;

export type DisplayedBasemapKind =
  (typeof DISPLAYED_BASEMAP)[keyof typeof DISPLAYED_BASEMAP];

/**
 * The resolved displayed base-map: which reference to paint and its world meta.
 * The render adapter resolves `source` to an image (the preset id → bundled asset;
 * a user source → the project-copied asset).
 */
export interface ResolvedBasemap {
  readonly kind: DisplayedBasemapKind;
  readonly source: string;
  readonly meta: EquirectangularMeta;
}

/**
 * Resolve which base-map to display from a project's stored base-map reference
 * (spec 受け入れ基準 1). A SINGLE decision funnels every trigger:
 *   - empty / preset reference (初回起動 = empty default, 新規 = preset, 読込失敗 =
 *     caller passes empty after the differ fell back) → the PRESET,
 *   - any other non-empty reference → a USER map at the full-world meta.
 * `loadable` lets the caller report a load failure (file欠落・破損): when a user
 * reference is not loadable, this resolves to the PRESET (読込失敗 → プリセット,
 * FR-03). Pure; the same input always yields the same displayed kind, so the three
 * trigger paths are testable by input → displayed kind (受け入れ基準 1).
 */
export function resolveDisplayedBasemap(
  baseMapRef: string,
  loadable = true,
): ResolvedBasemap {
  if (baseMapRef === '' || baseMapRef === PRESET_BASEMAP_ID || !loadable) {
    return {
      kind: DISPLAYED_BASEMAP.Preset,
      source: PRESET_BASEMAP_ID,
      meta: FULL_WORLD_META,
    };
  }
  return {
    kind: DISPLAYED_BASEMAP.User,
    source: baseMapRef,
    meta: FULL_WORLD_META,
  };
}

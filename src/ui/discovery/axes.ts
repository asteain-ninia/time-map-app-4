// U41 — display-control filter axes (FR-113 / FR-34 / FR-38, ui layer, pure).
//
// 機能宣言: 地物の表示制御は「フィルター対象を束ねる表示上のグルーピング軸」として
// 定義する。FR-34 はドメインに独立した順序属性・全体共通の重ね順序を導入しないと定める
// ので、本ユニットは軸の識別子を型定義・定数で固定し、表示文字列や思い込みで分岐しない
// (教訓 5.19「分岐識別子は型定義・定数・ファクトリを経由する」). 軸は三つ:
//   - 地物種別軸 (点 / 線 / 面)
//   - 階層深度軸 (面情報の派生値である階層深度。最上位=0、子=親+1。FR-38)
//   - 個別地物軸 (FeatureId 単位)
//
// 適用 (教訓 5.19): 軸・種別・しきい値の各識別子は本モジュールの定数 (FILTER_AXIS /
// FEATURE_KIND_AXIS) を経由してのみ参照し、作成・表示・検索・無効化の全経路で同じ値を
// 使う。ここに新軸を足すときも同じ定数を起点にする。
//
// この軸定義はドメインの真実 (地物データ) ではなくセッション固有の表示状態の語彙である。
// 階層深度そのものは依存ユニットの単一算出 (U08 派生深度) に委ねて再実装しない
// (単一の真実源)。本モジュールは「どの軸で束ねるか」だけを宣言する。

/**
 * The filter axes (FR-113). A feature's visibility is decided by combining ALL
 * three axes through ONE resolution (visibility.ts). The strings are an
 * implementation detail; code branches on these constants (教訓 5.19).
 */
export const FILTER_AXIS = {
  /** 地物種別軸: point / line / area visibility toggles. */
  Kind: 'kind',
  /** 階層深度軸: show features whose derived depth is at or below a threshold. */
  Depth: 'depth',
  /** 個別地物軸: per-feature override by FeatureId. */
  Individual: 'individual',
} as const;

export type FilterAxis = (typeof FILTER_AXIS)[keyof typeof FILTER_AXIS];

/**
 * The 地物種別 sub-axis values (FR-113: 点情報 / 線情報 / 面情報). This is the
 * DISPLAY-grouping kind, deliberately coarser than the domain's four-variant
 * discriminant (point / line / leaf / aggregate): leaf and aggregate are both
 * "面情報" for the purpose of a kind filter. The mapping from a domain feature
 * kind to this axis lives in ONE place (kindAxisOf) so it never drifts.
 */
export const FEATURE_KIND_AXIS = {
  Point: 'point',
  Line: 'line',
  Area: 'area',
} as const;

export type FeatureKindAxis =
  (typeof FEATURE_KIND_AXIS)[keyof typeof FEATURE_KIND_AXIS];

/** Every kind-axis value, for exhaustive defaults/iteration. */
export const ALL_FEATURE_KIND_AXES: readonly FeatureKindAxis[] = [
  FEATURE_KIND_AXIS.Point,
  FEATURE_KIND_AXIS.Line,
  FEATURE_KIND_AXIS.Area,
] as const;

/**
 * The domain feature-kind discriminant values (mirrors domain `FEATURE_KIND`).
 * Kept as a local string-literal union so this ui module needs no value import
 * from the domain just to map a kind; the mapping itself is asserted against the
 * domain constant in tests (教訓 5.33: the cross-layer contract is pinned by a
 * test, not by accidental string equality).
 */
export type DomainFeatureKind = 'point' | 'line' | 'leaf' | 'aggregate';

/**
 * Map a domain feature kind to its display kind-axis. Point→Point, Line→Line,
 * Leaf/Aggregate→Area. The ONE source for "which kind-axis owns this feature"
 * so the kind filter, the kind toggle UI and search母集合 all agree (教訓 5.29).
 */
export function kindAxisOf(kind: DomainFeatureKind): FeatureKindAxis {
  switch (kind) {
    case 'point':
      return FEATURE_KIND_AXIS.Point;
    case 'line':
      return FEATURE_KIND_AXIS.Line;
    case 'leaf':
    case 'aggregate':
      return FEATURE_KIND_AXIS.Area;
  }
}

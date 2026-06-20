// U41 — boundary adapters to the dependency units (教訓 5.33 / 5.34, ui layer).
//
// 機能宣言: 依存先 (U20 メニュー/ショートカット/文言、U32 表示状態/属性読み取り、U16
// 現在時刻/選択/カメラ) が公開する正確な API 名・型・状態キーはそれらの成果物に従う。
// 依存先 API が未確定の段階では、本ユニット内に明示的な境界インタフェース (adapter) を
// 定義してそこへ依存先を接続し、未確定部分を局所化する (依存 §注).
//
// 適用 (教訓 5.33 / 5.34「層をまたぐ契約・コンポーネント間契約を型で明示」): 状態キー・
// 公開する表示状態型・関数名は偶然の一致に頼らず、本モジュールの型付きインタフェースで
// 固定する。各依存ユニットの確定 API はこのアダプタの実装として後で接続する (現状.md に
// 接続点を保留として記録)。
//
// 純粋: 型と、注入された関数からこのユニットの入力 (表示状態母集合・検索コーパス) を組み立てる
// 純粋ヘルパーのみ。依存先の具体実装には直接依存しない。

import type { FeatureId } from '../../domain/ids';

import type { DomainFeatureKind } from './axes';
import { kindAxisOf } from './axes';
import { toSearchableText } from './sanitize';
import type { SearchableFeature } from './search';
import type { FeatureDisplayMeta } from './visibility';

/**
 * The U32 read port: the現在の表示状態 (現在時刻に有効な地物集合とその属性). The
 * adapter reads through this; it never duplicates or mutates the domain truth
 * (依存: 購読・読み取りのみ). One record per feature currently relevant to the
 * session, supplied by U32 in display order.
 */
export interface FeatureReadModel {
  readonly id: FeatureId;
  readonly kind: DomainFeatureKind;
  /** U08 derived hierarchy depth (最上位=0); null for non-area / undefined. */
  readonly depth: number | null;
  /** 名前 (FR-97). */
  readonly name: string;
  /**
   * 説明 — the RAW Markdown source (FR-98). The adapter sanitizes it to素テキスト
   * via toSearchableText BEFORE it enters the search corpus (FR-116).
   */
  readonly descriptionMarkdown: string;
  /** 属性値 (種別ラベル FR-40 / 年代 FR-97 ほか) already stringified for search. */
  readonly attributeValues: readonly string[];
}

/**
 * The U16 time/existence port: whether a feature exists at the現在時刻. Injected
 * (the time model is U16's single source) — this unit never resolves time itself
 * (教訓 5.15 / 単一の真実源).
 */
export interface ExistencePort {
  /** True iff the feature is present at the current time (現在時刻に存在する). */
  presentAtCurrentTime(featureId: FeatureId): boolean;
}

/**
 * The U16 camera/selection port: jump = move the camera to a feature and, when
 * it is selectable, set the selection. The actual camera/selection mutations are
 * U16's actions; this is the typed boundary the jump path calls (教訓 5.34).
 */
export interface JumpPort {
  /** Move the camera so the feature is in view (FR-113 結果へジャンプ). */
  moveCameraTo(featureId: FeatureId): void;
  /** Set the active selection to the feature (only when present-at-time). */
  selectFeature(featureId: FeatureId): void;
}

/** Map a U32 read record to the display-resolution meta (visibility.ts input). */
export function toDisplayMeta(record: FeatureReadModel): FeatureDisplayMeta {
  return { id: record.id, kind: record.kind, depth: record.depth };
}

/**
 * Build a search corpus record from a U32 read record: the description is
 * sanitized to素テキスト here (the search-side sanitize入口, FR-116), and the
 * coarse kind-axis is derived through the single mapping (axes.kindAxisOf). The
 * caller passes ONLY records that are visible at the current time (the visible
 * 母集合, 教訓 5.3) so a non-visible feature never enters the corpus.
 */
export function toSearchableFeature(record: FeatureReadModel): SearchableFeature {
  return {
    id: record.id,
    kind: kindAxisOf(record.kind),
    name: record.name,
    description: toSearchableText(record.descriptionMarkdown),
    attributes: record.attributeValues,
  };
}

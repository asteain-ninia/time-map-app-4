// 日本語 user-facing notices for the base-map差し替え flow (U18 / FR-04 / FR-115).
// Domain layer: pure string constants/derivation (no I/O). The differ decision is
// a structured value (format.ts); this module turns it into a日本語 notice so the
// reason is available BOTH as a return value AND a user message (教訓 5.26).
//
// FR-115: 日本語のみ。文言は定数モジュールへ集約 (技術方針 5.5 / 開発ガイド). Where
// useful, the "開発者へ報告してください" suffix is appended (per FR-115 方針).

import {
  type BasemapDecision,
  type BasemapFallbackReason,
  BASEMAP_FALLBACK_REASON,
  BASEMAP_OUTCOME,
} from './format';

/** The日本語 notice for each fallback reason. */
const FALLBACK_NOTICE: Readonly<Record<BasemapFallbackReason, string>> = {
  [BASEMAP_FALLBACK_REASON.InvalidImage]:
    '指定された地図ファイルを画像として読み込めませんでした。プリセット地図に戻します。',
  [BASEMAP_FALLBACK_REASON.Uncorrectable]:
    '指定された地図は正距円筒図法（縦横比2:1）に補正できませんでした。プリセット地図に戻します。',
};

/** The日本語 notice for a successful (possibly corrected) adoption. */
const ADOPTED_NOTICE = '指定された地図をベースマップに設定しました。';
const CORRECTED_NOTICE =
  '指定された地図を正距円筒図法（縦横比2:1）に補正してベースマップに設定しました。';

/**
 * The日本語 notice for a differ decision. Success paths confirm adoption /
 * correction; the fallback path explains why and that the preset is restored.
 * Pure: the decision drives the message (single source, 教訓 5.29).
 */
export function basemapNotice(decision: BasemapDecision): string {
  switch (decision.outcome) {
    case BASEMAP_OUTCOME.Adopted:
      return ADOPTED_NOTICE;
    case BASEMAP_OUTCOME.CorrectedAndAdopted:
      return CORRECTED_NOTICE;
    case BASEMAP_OUTCOME.FallbackToPreset:
      return FALLBACK_NOTICE[decision.reason];
  }
}

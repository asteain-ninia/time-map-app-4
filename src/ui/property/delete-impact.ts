// UI layer (U31 / 素性欄): **削除の影響を文にする**（設計書 §A.3 / 増分 7 の中身 6・7）。
//
// ドメインの {@link describeDeletionImpact} は件数と ID しか返さない（数を恒久文書へ
// 書き写さないのと同じ理由で、文はドメインに置かない）。この module がその数を
// **画面に出す文**へ写す 1 か所である。純粋なので検査で固定できる。
//
// **数え上げと文を分ける理由**: 方針が「参照があれば断る」へ転んでも、変わるのは
// {@link DeleteImpactView.blockedReason} と実行ボタンの文言だけで、影響の一覧そのものは
// 同じである（設計書 §A.3 の「方針中立の UI 契約」）。
//
// **いまの裁定は (あ)（掃除して消す）** なので、`judgeDeletion` の判定は **実行を止めず**
// 「気をつけること」の行として出す（下の注記を読むこと）。

import type { DeletionImpact } from '../../domain/deletion/index';
import { DELETE_VERDICT, deleteRejectMessage } from '../../domain/deletion/index';
import type { FeatureId } from '../../domain/ids';
import type { ImpactGroup } from '../shell/ImpactConfirmDialog';

import { PROPERTY_STRINGS } from './messages';

/**
 * 影響ダイアログへ渡す一式（見出し・群・断りの理由・ボタンの文言）。
 *
 * **群は 4 つ**: 一緒に消えるもの／他から参照されているところ／自動で消える地物／
 * 気をつけること。行が 0 本の群は器が出さないので、当てはまらない見出しは画面に出ない。
 */
export interface DeleteImpactView {
  readonly title: string;
  readonly groups: readonly ImpactGroup[];
  /** 実行できない理由（できるなら null）。 */
  readonly blockedReason: string | null;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly note: string;
}

/** 名前の一覧を「A・B ほか n 件」に畳む（一覧が長すぎて読めなくならないように）。 */
export function summarizeNames(
  names: readonly string[],
  head = 2,
): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, head);
  const rest = names.length - shown.length;
  return rest === 0
    ? shown.join('・')
    : PROPERTY_STRINGS.impactNamesWithRest(shown.join('・'), rest);
}

/**
 * 「この地物を全部の年から消します」の影響ダイアログの中身を組み立てる。
 *
 * 群は設計書 §A.3 の文面どおり 3 つ ＋ 判定の 1 つ:
 *   1. 一緒に消えるもの（この地物の錨・頂点）
 *   2. 他から参照されているところ（下位領域が全部の年で最上位へ移る）
 *   3. 自動で消える地物（下位領域を全部失った集約。FR-41）
 *   4. 気をつけること（`judgeDeletion` が「再編不能」と言ったとき。**止めはしない**）
 */
export function buildDeleteImpactView(input: {
  readonly impact: DeletionImpact;
  readonly targetName: string;
  readonly nameOf: (featureId: FeatureId) => string | null;
}): DeleteImpactView {
  const { impact, targetName, nameOf } = input;

  const anchorLine =
    impact.ownAnchorYears.length === 0
      ? PROPERTY_STRINGS.impactNoOwnAnchors
      : PROPERTY_STRINGS.impactAnchors(
          impact.ownAnchorYears.length,
          impact.ownAnchorYears.map((y) => PROPERTY_STRINGS.impactYear(y)).join(' / '),
        );

  const vertexLine = impact.ownsShape
    ? PROPERTY_STRINGS.impactVertices(impact.vertexCount)
    : PROPERTY_STRINGS.impactVerticesAggregate;

  const promotedNames = impact.promotedChildIds
    .map((id) => nameOf(id))
    .filter((n): n is string => n !== null);
  const promoted: readonly string[] =
    impact.promotedChildIds.length === 0
      ? []
      : [
          PROPERTY_STRINGS.impactPromoted(
            impact.promotedChildIds.length,
            summarizeNames(promotedNames),
          ),
        ];

  const autoNames = impact.autoRemovedIds
    .map((id) => nameOf(id))
    .filter((n): n is string => n !== null);
  const auto: readonly string[] =
    impact.autoRemovedIds.length === 0
      ? [PROPERTY_STRINGS.impactAutoRemovedNone]
      : [
          PROPERTY_STRINGS.impactAutoRemoved(
            impact.autoRemovedIds.length,
            summarizeNames(autoNames),
          ),
        ];

  // **判定は「注意」として出す。実行は止めない**（裁定一覧 A の 2026-09-03 ＝ 方針 (あ)。
  // 設計書 §A.3）。`judgeDeletion` が言う「再編不能」は、掃除したあとの階層が U08 の
  // 不変条件に触れる、という **警告**である ―― (あ) は「掃除して消す」と決めており、
  // 消せなくする側は方針 (い) の振る舞いである。
  //
  // **器は止められる形のまま残してある**（`blockedReason`）。裁定が (い) へ転んだら、
  // ここで `deleteRejectMessage(...)` を返すだけで実行ボタンが灰色になって理由が
  // 脇に出る ―― 画面は作り直さない（§A.3 の「方針中立の UI 契約」）。
  const caution: readonly string[] =
    impact.verdict.kind === DELETE_VERDICT.Rejected
      ? [deleteRejectMessage(impact.verdict.reason)]
      : [];

  const groups: readonly ImpactGroup[] = [
    {
      testId: 'gone',
      heading: PROPERTY_STRINGS.impactHeadingGone,
      lines: [anchorLine, vertexLine],
    },
    {
      testId: 'referenced',
      heading: PROPERTY_STRINGS.impactHeadingReferenced,
      lines: promoted,
    },
    {
      testId: 'auto',
      heading: PROPERTY_STRINGS.impactHeadingAuto,
      lines: auto,
    },
    {
      testId: 'caution',
      heading: PROPERTY_STRINGS.impactHeadingCaution,
      lines: caution,
    },
  ];

  return {
    title: PROPERTY_STRINGS.impactTitle(targetName),
    groups,
    blockedReason: null,
    confirmLabel: PROPERTY_STRINGS.impactConfirm,
    cancelLabel: PROPERTY_STRINGS.impactCancel,
    note: PROPERTY_STRINGS.impactUndoNote,
  };
}

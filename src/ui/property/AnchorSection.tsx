// UI layer (U32 / property panel): the anchor section (FR-84).
//
// **素性欄の「時間バー表示」の切替を外した**（増分 2 の手直し E1 / バグ狩り #8 /
// 裁定 §N-8 の推奨 (A)）。条文 FR-60（could）は 2 種類の切替を求めているが、実物は
//   - 錨が 2 本以上あると全部のバーが「継続中」として右端まで伸びて重なる、
//   - 幅 480px 固定なので幅 280px の欄からはみ出す、
//   - 目盛りに月日が出る（実データの錨はすべて年だけ）、
// という状態で、読めるものになっていなかった。時間バーは **下の時刻レール（増分 6）**
// が担い、素性欄はリスト（表）だけにする。同じものが 2 か所にあると「どちらが正か」で
// 迷う、という §N-8 の理由もそのまま当てはまる。
//
// 部品（`AnchorTimeBar` / `timebar.ts`）は **増分 6 で流用するので残してある**。
// バーの右端を「次の錨の始まり」で切る誤りだけはこの手直しで直した（AnchorTimeBar.tsx）。

import type { AnchorEntry } from '../../domain/anchor-series';
import type { AnchorId, FeatureId } from '../../domain/ids';
import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';

import type { AnchorRow } from './anchor-diff';
import { AnchorList } from './AnchorList';
import type { AnchorIntervalEditIntent } from './contracts';
import { PROPERTY_STRINGS } from './messages';

export interface AnchorSectionProps {
  /** 錨表に出す行（錨とその「前の錨」の組、B2）。 */
  readonly rows: readonly AnchorRow[];
  /**
   * 差分の文を作る相手（増分 2 の中身 5）。まとめ役の子を選んでいるときは **その子の
   * id** で、`series` は親のものになる（設計書 §C.6「まとめ役の子の錨」）。
   */
  readonly featureIdForDiff: FeatureId;
  /** 既定で出す範囲（現在時刻の前後）を決めるための現在時刻。 */
  readonly currentTime: TimePoint;
  readonly calendar: Calendar;
  readonly selectedAnchorId: AnchorId | null;
  readonly onSelectAnchor: (entry: AnchorEntry) => void;
  /**
   * HB3-12: the target feature id (routing for存続期間 intents). Present only when the
   * host wired the存続期間 dispatch AND the form is editable; its presence (with
   * {@link onEditInterval}) switches the LIST view from read-only to editable.
   */
  readonly featureId?: FeatureId;
  /** HB3-12: dispatch a存続期間 edit; returns an error message to show, or null. */
  readonly onEditInterval?: (intent: AnchorIntervalEditIntent) => string | null;
  /** 「板が出ている」と名乗る口（司令塔の決定 (13)）。錨の削除の確認へ渡す。 */
  readonly onModalChange?: (open: boolean) => void;
  /** 上位領域の表示名を根から引く落とし先（バグ狩り #5）。 */
  readonly resolveParentName?: (featureId: FeatureId) => string | null;
}

export function AnchorSection(props: AnchorSectionProps): JSX.Element {
  const {
    rows,
    featureIdForDiff,
    currentTime,
    calendar,
    selectedAnchorId,
    onSelectAnchor,
    featureId,
    onEditInterval,
  } = props;

  return (
    /* 増分 2 の手直し D2 / 設計書 §C.6: 節は畳める。初期は折りたたみ。畳んだままでも
       本数が読めるように、見出しに本数を添える（「▸ 歴史の錨 1 本」）。 */
    <details className="anchor-section" data-testid="anchor-section">
      <summary data-testid="anchor-section-summary">
        {PROPERTY_STRINGS.anchorSectionTitle} {PROPERTY_STRINGS.anchorCount(rows.length)}
      </summary>

      <AnchorList
        rows={rows}
        featureIdForDiff={featureIdForDiff}
        currentTime={currentTime}
        calendar={calendar}
        selectedAnchorId={selectedAnchorId}
        onSelectAnchor={onSelectAnchor}
        {...(featureId !== undefined && onEditInterval !== undefined
          ? { featureId, onEditInterval }
          : {})}
        {...(props.onModalChange ? { onModalChange: props.onModalChange } : {})}
        {...(props.resolveParentName ? { resolveParentName: props.resolveParentName } : {})}
      />
    </details>
  );
}

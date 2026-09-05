// 地物一覧（台帳）のセッション状態（増分 4 / 設計書 §C.5）。純粋・イミュータブル。
//
// **なぜストアに置くか**: 束（作業のまとまり）のカーソルは、一覧だけのものではない。
//   - 素性欄の Enter は「保存して**次へ**」なので、素性欄がカーソルを進める
//   - Ctrl+Z は改名だけを戻し、**カーソルは戻った地物へ移る**（設計書 §C.5）
//   - Ctrl+P の候補は一覧と同じ母集団・同じ重複名の見分けを使う
// つまり 3 つの部品が同じ 1 つの状態を読み書きするので、一覧の React state に閉じ込めると
// 真実源が割れる（教訓 5.29）。
//
// **保存形式には何も足さない**（K-9）。`filter` / `survey` と同じ「セッション限りの表示
// 状態」で、プロジェクトを開き直したら捨てる（教訓 5.2）。ただし **束は開き直しても
// 同じ式を選べば同じ 220 件が同じ並びで出る**（`bundle.ts` の通史による当てはめ）ので、
// 捨てても作業は続けられる。

import type { FeatureId } from '../../domain/ids';

import type { Bundle } from './bundle';

/** 一覧の母集団（U-18 の裁定どおり 2 つのまま。§N-14 の (A)）。 */
export const LEDGER_MODE = {
  /** 現在の年に存在する地物。 */
  Current: 'current',
  /** 全時刻の錨（通史）。 */
  History: 'history',
} as const;

export type LedgerMode = (typeof LEDGER_MODE)[keyof typeof LEDGER_MODE];

export interface LedgerState {
  readonly mode: LedgerMode;
  /** true = 木（階層をたどる）、false = 平。 */
  readonly tree: boolean;
  /** 絞り込み語（名前・種別）。**「地物を検索」はこの 1 本に統合した**（E-6）。 */
  readonly query: string;
  /** 展開している地物（木のとき）。 */
  readonly expanded: ReadonlySet<FeatureId>;
  /** いまの作業のまとまり（無ければ null）。 */
  readonly bundle: Bundle | null;
  /** 束の未処理だけに絞るか。 */
  readonly onlyUnfinished: boolean;
}

/** 既定。束は無く、木で、絞り込みなし。 */
export const DEFAULT_LEDGER_STATE: LedgerState = {
  mode: LEDGER_MODE.Current,
  tree: true,
  query: '',
  expanded: new Set(),
  bundle: null,
  onlyUnfinished: false,
};

/** 展開を 1 件切り替える。変化が無ければ同じ参照を返す（描画の世代を進めない）。 */
export function toggleExpanded(state: LedgerState, featureId: FeatureId): LedgerState {
  const next = new Set(state.expanded);
  if (next.has(featureId)) next.delete(featureId);
  else next.add(featureId);
  return { ...state, expanded: next };
}

/** 展開を明示的に設定する（Ctrl+P や右クリックから 1 件を見せるときに使う）。 */
export function withExpanded(
  state: LedgerState,
  featureIds: Iterable<FeatureId>,
): LedgerState {
  const next = new Set(state.expanded);
  let changed = false;
  for (const id of featureIds) {
    if (!next.has(id)) {
      next.add(id);
      changed = true;
    }
  }
  return changed ? { ...state, expanded: next } : state;
}

/**
 * 生きている地物だけを展開集合に残す（教訓 5.5 / 5.11）。id で鍵を持つ集合なので、
 * 削除・取り消しで消えた id を掃除しないと、取り消しで同じ id が戻ったときに
 * 古い展開状態が別の地物へ付く。変化が無ければ同じ参照を返す。
 */
export function reconcileLedgerToLive(
  state: LedgerState,
  liveFeatureIds: ReadonlySet<FeatureId>,
): LedgerState {
  let changed = false;
  const expanded = new Set<FeatureId>();
  for (const id of state.expanded) {
    if (liveFeatureIds.has(id)) expanded.add(id);
    else changed = true;
  }
  return changed ? { ...state, expanded } : state;
}

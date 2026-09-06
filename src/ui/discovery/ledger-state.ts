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
  /**
   * **利用者が自分で畳んだ地物**（手直し B3）。絞り込みが自動で開く先祖より強い。
   * これが無いと「絞り込み中は親の三角を押しても畳めない」になる。
   */
  readonly collapsed: ReadonlySet<FeatureId>;
  /** いまの作業のまとまり（無ければ null）。 */
  readonly bundle: Bundle | null;
  /** 束の未処理だけに絞るか。 */
  readonly onlyUnfinished: boolean;
  /**
   * **手で印を付けた地物**（`markedFeatures`。増分 7 / 設計書 §D.5）。
   *
   * **選択（`activeFeature`）とは別の概念**である。選択は 0 か 1 件（FR-79）で「いま
   * 素性欄が映しているもの」だが、印は「まとめて片付ける相手」の集合で、2 件以上に
   * なりうる ―― 結ぶ・連邦化・一括の種別付与がこれを読む。設計書 §D.5 が
   * 「`activeFeature` と別概念に立てる」と定めているのはこの理由による。
   *
   * **保存形式には入れない**（K-9）。展開状態と同じセッション限りの表示状態で、
   * 生きていない地物は {@link reconcileLedgerToLive} が掃除する。
   */
  readonly marked: ReadonlySet<FeatureId>;
}

/** 既定。束は無く、木で、絞り込みなし。 */
export const DEFAULT_LEDGER_STATE: LedgerState = {
  mode: LEDGER_MODE.Current,
  tree: true,
  query: '',
  expanded: new Set(),
  collapsed: new Set(),
  bundle: null,
  onlyUnfinished: false,
  marked: new Set(),
};

/**
 * 展開を 1 件切り替える。
 *
 * **いま開いているかは呼び出し側が渡す**（手直し B3）。絞り込み中は「一致した子の
 * 先祖を自動で開く」が効いていて、開いているかどうかは `expanded` だけでは決まらない。
 * 画面が見ている状態（行の三角の向き）をそのまま渡してもらい、
 *   - 開いている → `collapsed` へ入れて `expanded` から外す（自動の開きより強い）
 *   - 閉じている → `expanded` へ入れて `collapsed` から外す
 * とする。変化が無ければ同じ参照を返す（描画の世代を進めない）。
 */
export function toggleExpanded(
  state: LedgerState,
  featureId: FeatureId,
  expandedNow: boolean,
): LedgerState {
  const expanded = new Set(state.expanded);
  const collapsed = new Set(state.collapsed);
  if (expandedNow) {
    expanded.delete(featureId);
    collapsed.add(featureId);
  } else {
    expanded.add(featureId);
    collapsed.delete(featureId);
  }
  return { ...state, expanded, collapsed };
}

/** 展開を明示的に設定する（Ctrl+P や右クリックから 1 件を見せるときに使う）。 */
export function withExpanded(
  state: LedgerState,
  featureIds: Iterable<FeatureId>,
): LedgerState {
  const next = new Set(state.expanded);
  const collapsed = new Set(state.collapsed);
  let changed = false;
  for (const id of featureIds) {
    if (!next.has(id)) {
      next.add(id);
      changed = true;
    }
    // **自分で畳んだ印も外す**。外さないと「Ctrl+P で子を選んだのに親が畳まれたまま」
    // になり、選んだ行が一覧に出てこない（手直し B2 が直そうとしていることそのもの）。
    if (collapsed.delete(id)) changed = true;
  }
  return changed ? { ...state, expanded: next, collapsed } : state;
}

/**
 * 印を 1 件切り替える（増分 7 / 設計書 §D.5）。変化が無ければ同じ参照を返す。
 */
export function toggleMarked(state: LedgerState, featureId: FeatureId): LedgerState {
  const marked = new Set(state.marked);
  if (!marked.delete(featureId)) marked.add(featureId);
  return { ...state, marked };
}

/** 印を明示的に置き換える（右クリックの「その全下位領域を対象にする」など）。 */
export function withMarked(
  state: LedgerState,
  featureIds: Iterable<FeatureId>,
): LedgerState {
  const marked = new Set(featureIds);
  if (marked.size === state.marked.size && [...marked].every((id) => state.marked.has(id))) {
    return state;
  }
  return { ...state, marked };
}

/** 印を全部外す。 */
export function clearMarked(state: LedgerState): LedgerState {
  if (state.marked.size === 0) return state;
  return { ...state, marked: new Set() };
}

/**
 * 生きている地物だけを展開集合・印の集合に残す（教訓 5.5 / 5.11）。id で鍵を持つ集合
 * なので、削除・取り消しで消えた id を掃除しないと、取り消しで同じ id が戻ったときに
 * 古い状態が別の地物へ付く。変化が無ければ同じ参照を返す。
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
  const collapsed = new Set<FeatureId>();
  for (const id of state.collapsed) {
    if (liveFeatureIds.has(id)) collapsed.add(id);
    else changed = true;
  }
  // **印も同じ理由で掃除する**（増分 7）。所属変更・削除で消えた id を残すと、
  // 「3 件をまとめて」の件数が実物と食い違う。
  const marked = new Set<FeatureId>();
  for (const id of state.marked) {
    if (liveFeatureIds.has(id)) marked.add(id);
    else changed = true;
  }
  return changed ? { ...state, expanded, collapsed, marked } : state;
}

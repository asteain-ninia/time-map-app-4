// UI 層（地図マウントの結線）: 「描画 / 当たり判定 / 入力 / 観測」の 4 つが共有する型だけ
// を置く。実行時のコードは 1 行も無い。
//
// なぜ 1 枚挟むか: 4 つとも同じ U16 セッションストアを読み、うち 3 つが同じ可変の受け渡し
// 箱を触る。型の持ち主をどれか 1 つの部品に決めると、上流（観測）が下流（描画）から型を
// 輸入する形になって読み筋が逆流するので、型だけの小さなモジュールを共有の置き場にする。

import type { StoreApi } from 'zustand/vanilla';

import type { DragSession } from '../../../domain/editing/index';
import type { DomainProject } from '../../../domain/persistence/index';
import type { SessionStore } from '../../state/store';
import type { RubberBand } from '../rubber-band';

/** 真実の根は U14 の永続 {@link DomainProject}（App.tsx の `DomainRoot` と同じもの）。 */
export type MountDomainRoot = DomainProject;

/** マウント配下の 4 部品が読む、唯一の U16 セッションストア。 */
export type MountStore = StoreApi<SessionStore<MountDomainRoot>>;

/**
 * 部品どうしをまたぐ「先に宣言して後から差し替える」参照の置き場（1 個の可変オブジェクト）。
 * 分割前は `onMapMount` の中の `let` 3 本だった。持ち主と使い手が別ファイルへ分かれても
 * 差し替えが伝わるよう、値そのものではなく **この箱ごと** 各ファクトリへ渡す（分割前と同じ
 * 遅延結線の形をそのまま持ち越しただけで、規則は 1 つも変えていない）。
 */
export interface MountTransients {
  /**
   * HB3-4 — 進行中の編集ドラッグ（U24 のドラッグセッション）。当たり判定側の
   * `onPreview` が書き、描画側の `editHandles` / `editPreviewActive` が読む。
   * 真実は持たない（確定は onReleased → recordCommit を通る）。
   */
  liveEditSession: DragSession | null;
  /** HB3-4 — 上のプレビューを 1 フレームに畳んで再描画する。描画側が実体を入れる。 */
  scheduleEditPreviewRedraw: () => void;
  /** 押下時に保留中の再描画を吐き出して「見える＝掴める」を保つ。描画側が実体を入れる。 */
  flushRedraw: () => void;
  /**
   * 増分 8A（N-07）— ドラッグ中の矩形選択の枠。当たり判定側（選択の口を包む
   * `withRubberBand`）が書き、描画側の `editHandles` が読む。真実は持たない。
   * 任意にしてあるのは、箱を組む側（App.tsx）の既存の行を書き換えずに足すため
   * （無い＝枠を描いていない、と同じ意味）。
   */
  rubberBand?: RubberBand | null;
}

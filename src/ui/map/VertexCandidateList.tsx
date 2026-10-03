// UI layer (U16 / 地図): 頂点の候補一覧（設計書 §B.5 の台帳 #12 / V9）。
//
// **クリック位置の右下 8px に出す。地図セルの端に当たったら内側へ寄せる。**
// 層は `pointer-events: none` で、**一覧の矩形だけ**が押下を受ける（K-2）。
// **Escape と地図の他所のクリックで必ず消える**（消す経路は `VertexCandidateStore.clear`
// の 1 本を通る ―― 閉じ方が経路ごとに割れると、閉じたつもりで居座る＝教訓 5.56 / 5.44）。
//
// 増分 8A: 閉じ方と鍵盤の持ち主への名乗りは、ほかの一時的な吹き出し（台帳 #5・#13〜#16）と
// **同じ作法の 1 か所**（`shell/use-dismissable`）を通す。文書全体の押下の捕捉段と Escape で
// 閉じ、開閉を `onOpenChange` で報せる（App は `popover` を名乗らせる ―― 設計書 §B.5 の
// `focusOwner = popover`。板ではないので `modal` にはしない）。
// `role="dialog"`（非モーダル）にしてあるのは、K-2 の走査が板・吹き出しを `role` で
// 1 枚として数えるためである（中の行の名前が地図の点として返らないように）。

import { useRef, useSyncExternalStore, useState, useLayoutEffect } from 'react';

import type { FeatureId, VertexId } from '../../domain/ids';
import { useDismissable } from '../shell/use-dismissable';

import { VERTEX_CANDIDATE_MAX_ROWS, type VertexCandidateStore } from './vertex-candidates';

/** 画面に出る言葉（教訓 5.64）。 */
export const VERTEX_CANDIDATE_STRINGS = {
  heading: 'この位置の頂点',
  hint: '掴める距離に複数あります。1 つ選んでください。',
  close: '閉じる',
  more: (count: number): string => `ほか ${String(count)} 件。拡大すると絞れます。`,
  /** 残りを出すボタン（増分 8A の手直し・GPT #1。21 件目より先にも選ぶ道を残す）。 */
  showMore: 'もっと見る',
} as const;

/** 一覧の大きさ（地図の端で内側へ寄せるときに使う）。CSS と同じ値。 */
export const VERTEX_CANDIDATE_WIDTH = 280;
export const VERTEX_CANDIDATE_MAX_HEIGHT = 240;
/** クリック位置からのずらし（設計書 §B.5 の「右下 8px」）。 */
export const VERTEX_CANDIDATE_OFFSET = 8;

/** 閉じる契機の指紋（中身では閉じない ―― 新しい一覧が出た瞬間に自分を閉じないように）。 */
const CLOSE_KEY = 'vertex-candidates';

export interface VertexCandidateListProps {
  readonly store: VertexCandidateStore;
  /** 1 つ選んだ（その頂点を選択にする）。 */
  readonly onPick: (featureId: FeatureId, vertexId: VertexId) => void;
  /**
   * 開閉の報せ（鍵盤の持ち主の `popover` を App が導出する）。開いたら true、閉じたとき・
   * 部品ごと外れたときは false が必ず届く（名乗りっぱなしで鍵盤が戻らない、を作らない）。
   */
  readonly onOpenChange?: (open: boolean) => void;
}

export function VertexCandidateList(props: VertexCandidateListProps): JSX.Element | null {
  const { store, onPick, onOpenChange } = props;
  const state = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.get(),
    () => store.get(),
  );
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [cellSize, setCellSize] = useState<{ w: number; h: number } | null>(null);
  // 描いている行数（一覧が出し直されたら最初の 1 頁へ戻す）。
  const [shownFor, setShownFor] = useState<{ state: unknown; count: number }>({
    state: null,
    count: VERTEX_CANDIDATE_MAX_ROWS,
  });
  const shownCount = shownFor.state === state ? shownFor.count : VERTEX_CANDIDATE_MAX_ROWS;

  // 地図セルの大きさは、出すたびに測る（窓の大きさが変わっても端で切れない）。
  useLayoutEffect(() => {
    if (state === null) return;
    const cell = boxRef.current?.parentElement;
    if (cell === undefined || cell === null) return;
    const r = cell.getBoundingClientRect();
    setCellSize({ w: r.width, h: r.height });
  }, [state]);

  // **Escape と、一覧の外の押下で必ず消える**（作法は台帳 #5 と同じ 1 か所）。
  // 地図の押下は `mount/input.ts` の側でも押すたびに畳むので、二重に閉じても害は無い
  // （`clear` は既に空なら何もしない）。
  useDismissable({
    open: state !== null,
    close: () => store.clear(),
    closeKey: CLOSE_KEY,
    insideRefs: [boxRef],
    onOpenChange,
  });

  if (state === null) return null;

  // 端に当たったら内側へ寄せる（測れていないうちは素直に右下へ出す）。
  let left = state.x + VERTEX_CANDIDATE_OFFSET;
  let top = state.y + VERTEX_CANDIDATE_OFFSET;
  if (cellSize !== null) {
    left = Math.max(0, Math.min(left, cellSize.w - VERTEX_CANDIDATE_WIDTH));
    top = Math.max(0, Math.min(top, cellSize.h - VERTEX_CANDIDATE_MAX_HEIGHT));
  }

  return (
    <div
      ref={boxRef}
      className="vertex-candidates"
      data-testid="vertex-candidates"
      role="dialog"
      aria-modal="false"
      aria-label={VERTEX_CANDIDATE_STRINGS.heading}
      style={{ left: `${String(Math.round(left))}px`, top: `${String(Math.round(top))}px` }}
    >
      <div className="vertex-candidates__head">
        <span>{VERTEX_CANDIDATE_STRINGS.heading}</span>
        <button
          type="button"
          data-testid="vertex-candidates-close"
          onClick={() => store.clear()}
        >
          {VERTEX_CANDIDATE_STRINGS.close}
        </button>
      </div>
      <p className="vertex-candidates__hint">{VERTEX_CANDIDATE_STRINGS.hint}</p>
      <ul className="vertex-candidates__list">
        {state.rows.slice(0, shownCount).map((row) => (
          <li key={`${String(row.featureId)}:${String(row.vertexId)}`}>
            <button
              type="button"
              data-testid={`vertex-candidate-${String(row.vertexId)}`}
              // 観測用（選ぶと選択の持ち主になる地物）。真実は持たない。
              data-feature-id={String(row.featureId)}
              // 行に乗っている・焦点がある間、地図の上でその頂点を輪で囲む（設計適合 2-3）。
              onPointerEnter={() => store.setHover(row.coordinate)}
              onPointerLeave={() => store.setHover(null)}
              onFocus={() => store.setHover(row.coordinate)}
              onBlur={() => store.setHover(null)}
              onClick={() => {
                onPick(row.featureId, row.vertexId);
                store.clear();
              }}
            >
              <span className="vertex-candidates__name">{row.label}</span>
              <span className="vertex-candidates__dist">
                {`${row.distancePx.toFixed(1)}px`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {state.rows.length > shownCount ? (
        <p className="vertex-candidates__more" data-testid="vertex-candidates-more">
          {VERTEX_CANDIDATE_STRINGS.more(state.rows.length - shownCount)}
          <button
            type="button"
            data-testid="vertex-candidates-show-more"
            onClick={() =>
              setShownFor({ state, count: shownCount + VERTEX_CANDIDATE_MAX_ROWS })
            }
          >
            {VERTEX_CANDIDATE_STRINGS.showMore}
          </button>
        </p>
      ) : null}
    </div>
  );
}

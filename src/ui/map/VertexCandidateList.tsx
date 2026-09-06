// UI layer (U16 / 地図): 頂点の候補一覧（設計書 §B.5 の台帳 #12 / V9）。
//
// **クリック位置の右下 8px に出す。地図セルの端に当たったら内側へ寄せる。**
// 層は `pointer-events: none` で、**一覧の矩形だけ**が押下を受ける（K-2）。
// **Escape と地図の他所のクリックで必ず消える**（消す経路は `VertexCandidateStore.clear`
// の 1 本を通る ―― 閉じ方が経路ごとに割れると、閉じたつもりで居座る＝教訓 5.56 / 5.44）。

import { useEffect, useRef, useSyncExternalStore, useState } from 'react';

import type { FeatureId, VertexId } from '../../domain/ids';

import type { VertexCandidateStore } from './vertex-candidates';

/** 画面に出る言葉（教訓 5.64）。 */
export const VERTEX_CANDIDATE_STRINGS = {
  heading: 'この位置の頂点',
  hint: '掴める距離に複数あります。1 つ選んでください。',
  close: '閉じる',
  unknownFeature: '（名前なし）',
} as const;

/** 一覧の大きさ（地図の端で内側へ寄せるときに使う）。CSS と同じ値。 */
export const VERTEX_CANDIDATE_WIDTH = 216;
export const VERTEX_CANDIDATE_MAX_HEIGHT = 180;
/** クリック位置からのずらし（設計書 §B.5 の「右下 8px」）。 */
export const VERTEX_CANDIDATE_OFFSET = 8;

export interface VertexCandidateListProps {
  readonly store: VertexCandidateStore;
  /** 1 つ選んだ（その頂点を選択にする）。 */
  readonly onPick: (featureId: FeatureId, vertexId: VertexId) => void;
}

export function VertexCandidateList(props: VertexCandidateListProps): JSX.Element | null {
  const { store, onPick } = props;
  const state = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.get(),
    () => store.get(),
  );
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [cellSize, setCellSize] = useState<{ w: number; h: number } | null>(null);

  // 地図セルの大きさは、出すたびに測る（窓の大きさが変わっても端で切れない）。
  useEffect(() => {
    if (state === null) return;
    const cell = boxRef.current?.parentElement;
    if (cell === undefined || cell === null) return;
    const r = cell.getBoundingClientRect();
    setCellSize({ w: r.width, h: r.height });
  }, [state]);

  // **Escape で必ず消える。** 捕捉段で聞いて、下の道具へ渡さない（一覧が出ている
  // あいだの Escape は「一覧をやめる」が正しい ―― §D.4 の階段の一番上）。
  useEffect(() => {
    if (state === null) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      store.clear();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [state, store]);

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
      role="group"
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
        {state.rows.map((row) => (
          <li key={`${String(row.featureId)}:${String(row.vertexId)}`}>
            <button
              type="button"
              data-testid={`vertex-candidate-${String(row.vertexId)}`}
              onClick={() => {
                onPick(row.featureId, row.vertexId);
                store.clear();
              }}
            >
              <span className="vertex-candidates__name">
                {row.featureName === '' ? VERTEX_CANDIDATE_STRINGS.unknownFeature : row.featureName}
              </span>
              <span className="vertex-candidates__dist">
                {`${row.distancePx.toFixed(1)}px`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

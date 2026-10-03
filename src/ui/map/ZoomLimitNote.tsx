// UI 層（地図）: ズームボタンの脇に出す「上限です」の短い文（増分 8E / G-21。設計書 §B.5 の
// 台帳 #27 = 一時部品）。
//
// **押せない**（`pointer-events: none`）。地図の上に覆いを作らないという K-2 の約束を守る
// ―― 文の矩形の下にある地図にも押下が届く。出るのは断った直後だけで、倍率が動いたら
// （縮小した・ホイールで動かした）消える。状態行の文（消えない）とは役割が違い、
// こちらは **押した場所のすぐ脇で** 理由を見せる。

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';

import { zoomLimitNoteVisible, type ZoomLimitNoteStore } from './zoom-limit-notice';

export interface ZoomLimitNoteProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  readonly noteStore: ZoomLimitNoteStore;
}

export function ZoomLimitNoteView<S>(props: ZoomLimitNoteProps<S>): JSX.Element | null {
  const { store, noteStore } = props;
  const note = useSyncExternalStore(noteStore.subscribe, noteStore.get, noteStore.get);
  // 倍率はこの葉ノードだけが購読する（技術方針 2.3。MapViewControls と同じ）。
  const zoom = useStore(store, (s) => s.camera.zoom);
  const visible = note !== null && zoomLimitNoteVisible(note, zoom);

  // **倍率が動いたら文そのものを消す**（増分 8E の手直し。GPT 重 2）。最初の版は表示の条件で
  // 隠すだけだったので、上限で断ったあとホイールで縮小し、元の倍率へ戻すと、新たに断って
  // いないのに古い文がまた出ていた。
  useEffect(() => {
    if (note !== null && !visible) noteStore.clear();
  }, [note, visible, noteStore]);

  // 開き直し・新規（`projectLoadNonce`）と、上下限の設定の変更でも消す（古い倍率の文を残さない）。
  const loadNonce = useStore(store, (s) => s.projectLoadNonce);
  const zoomMin = useStore(store, (s) => s.projectSettings.zoomMin);
  const zoomMax = useStore(store, (s) => s.projectSettings.zoomMax);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    noteStore.clear();
  }, [loadNonce, zoomMin, zoomMax, noteStore]);

  if (note === null || !visible) return null;
  return (
    <p className="map-zoom-limit-note" data-testid="map-zoom-limit-note" role="status">
      {note.text}
    </p>
  );
}

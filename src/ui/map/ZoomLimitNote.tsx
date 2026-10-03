// UI 層（地図）: ズームボタンの脇に出す「上限です」の短い文（増分 8E / G-21。設計書 §B.5 の
// 台帳 #27 = 一時部品）。
//
// **押せない**（`pointer-events: none`）。地図の上に覆いを作らないという K-2 の約束を守る
// ―― 文の矩形の下にある地図にも押下が届く。出るのは断った直後だけで、倍率が動いたら
// （縮小した・ホイールで動かした）消える。状態行の文（消えない）とは役割が違い、
// こちらは **押した場所のすぐ脇で** 理由を見せる。

import { useSyncExternalStore } from 'react';
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
  if (note === null || !zoomLimitNoteVisible(note, zoom)) return null;
  return (
    <p className="map-zoom-limit-note" data-testid="map-zoom-limit-note" role="status">
      {note.text}
    </p>
  );
}

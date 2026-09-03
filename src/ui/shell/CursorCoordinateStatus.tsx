// UI layer (U20 / shell): the status bar's live cursor-coordinate readout (FR-111).
//
// Subscribes to the React-external {@link CursorPositionStore} via
// `useSyncExternalStore`, so a 60Hz pointermove re-renders THIS node only — never the
// shell around it (技術方針 2.3: React は 60FPS 経路を駆動しない). When the cursor is
// not over the map (or the coordinate is 病的) the readout renders「—」(設計書 §H.6 の
// 表: 座標枠は地図の外では「—」)。**枠は残したまま中身だけ差し替える** ので、状態行の
// 240px の座標枠がカーソルの位置で伸び縮みすることはない (K-3 と同じ規則)。
//
// 以前ここは「準備完了」を返していた。状態行が座標 1 項目だけだった頃は「空欄にしない」
// ための措置として筋が通っていたが、5 枠になった今は他の枠が常に何かを出しているので、
// 座標枠にだけアプリ全体の状態語が出るのは読み違いのもとになる。

import { useSyncExternalStore } from 'react';

import { cursorCoordinateText, type CursorPositionStore } from './cursor-position';
import { STATUS_STRINGS } from './strings';

export interface CursorCoordinateStatusProps {
  readonly store: CursorPositionStore;
}

export function CursorCoordinateStatus(props: CursorCoordinateStatusProps): JSX.Element {
  const { store } = props;
  const position = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.get(),
    () => null,
  );
  const text = cursorCoordinateText(position);
  if (text === null) {
    return (
      <span className="statusbar__muted" data-testid="statusbar-cursor-coords">
        {STATUS_STRINGS.coordsAway}
      </span>
    );
  }
  return (
    <span className="statusbar__coords" data-testid="statusbar-cursor-coords">
      {text}
    </span>
  );
}

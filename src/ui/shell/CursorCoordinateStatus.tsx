// UI layer (U20 / shell): the status bar's live cursor-coordinate readout (FR-111).
//
// Subscribes to the React-external {@link CursorPositionStore} via
// `useSyncExternalStore`, so a 60Hz pointermove re-renders THIS node only — never the
// shell around it (技術方針 2.3: React は 60FPS 経路を駆動しない). When the cursor is
// not over the map (or the coordinate is 病的) the readout renders the SAME default
// ready label the bare status bar shows, so「地図外では非表示」でありながらステータス
// バーが空欄にならない (StatusBar 側の既定文言と一致 = 表示が二重管理にならない).

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
    return <span className="statusbar__ready">{STATUS_STRINGS.ready}</span>;
  }
  return (
    <span className="statusbar__coords" data-testid="statusbar-cursor-coords">
      {text}
    </span>
  );
}

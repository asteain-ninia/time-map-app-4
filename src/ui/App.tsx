// UI layer: React UI shell. May import domain and render only.
//
// The application root mounts the U20 layout shell (AppShell): top menu, left
// toolbar, central map area, right sidebar, bottom timeline slot + status bar
// (FR-111). The session store (U16) is the single truth source for mode / tool /
// selection / time; the shell binds to it and never holds map-draw state in
// React (技術方針 2.3). Later units fill the sidebar/timeline/overlay slots and
// register commands; this root wires the empty shell over a fresh store.

import { useMemo } from 'react';

import { createSessionStore } from './state/store';
import { AppShell } from './shell';
import './shell/shell.css';

export function App(): JSX.Element {
  // The domain truth root is owned by the domain/persistence units; the shell is
  // generic over it and never reaches inside (spec 依存: ルート状態を不変に受け
  // 渡す). Bootstrap with an empty opaque root until a load unit supplies one.
  const store = useMemo(() => createSessionStore<Record<string, never>>({ initialDomain: {} }), []);

  return (
    <div id="app-shell">
      <AppShell store={store} />
    </div>
  );
}

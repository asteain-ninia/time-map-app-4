// UI layer: React UI shell. May import domain and render only.
//
// The application root mounts the U20 layout shell (AppShell): top menu, left
// toolbar, central map area, right sidebar, bottom timeline slot + status bar
// (FR-111). The session store (U16) is the single truth source for mode / tool /
// selection / time; the shell binds to it and never holds map-draw state in
// React (技術方針 2.3).
//
// U23 INTEGRATION (教訓 5.7 完了トリガーの明示配線 / 教訓 5.2 全経路で破棄): the
// root now CONSUMES the add-tool flow — it mounts {@link AddToolController} in the
// shell overlay, bound to the same store. The controller turns toolbar tool
// selection into a session start, map-input pointer events into vertex placement,
// the complete / save buttons into the U23 logic, and feeds the provisional
// {@link buildAddPrimitives} batch to the live renderer. The renderer is created
// imperatively on map mount (技術方針 2.3) and its `screenToWorld` / `drawBatch`
// back the controller's ports.

import { useCallback, useMemo, useRef } from 'react';

import { createSessionStore } from './state/store';
import { AppShell } from './shell';
import './shell/shell.css';

import {
  AddToolController,
  type AddDrawSink,
  type ScreenToWorld,
} from './add/AddToolController';
import { createAddHostPorts, type AddHostPorts } from './add/host-ports';
import type { DrawPrimitive } from '../render/map-renderer';

/** The scaffold domain root: an opaque empty record until a load unit supplies one. */
type DomainRoot = Record<string, never>;

export function App(): JSX.Element {
  // The domain truth root is owned by the domain/persistence units; the shell is
  // generic over it and never reaches inside (spec 依存: ルート状態を不変に受け
  // 渡す). Bootstrap with an empty opaque root until a load unit supplies one.
  const store = useMemo(
    () => createSessionStore<DomainRoot>({ initialDomain: {} }),
    [],
  );

  // The live renderer is created imperatively on map mount (技術方針 2.3); we hold
  // it behind a ref so the add-tool ports read the current renderer without riding
  // a React re-render. Until the map mounts the ports degrade gracefully (no-op
  // draw / identity transform), so the wiring is real and never crashes pre-mount.
  const rendererRef = useRef<AddHostPorts | null>(null);

  const onMapMount = useCallback((el: HTMLDivElement): (() => void) => {
    const ports = createAddHostPorts(el);
    rendererRef.current = ports;
    return () => {
      ports.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Stable port closures the controller depends on; each reads the current
  // renderer through the ref (単一の真実源 — the renderer owns the transform).
  const screenToWorld: ScreenToWorld = useCallback(
    (clientX, clientY) =>
      rendererRef.current?.screenToWorld(clientX, clientY) ?? { lon: clientX, lat: clientY },
    [],
  );
  const drawSink: AddDrawSink = useMemo(
    () => ({
      drawAdd(primitives: readonly DrawPrimitive[]): void {
        rendererRef.current?.drawAdd(primitives);
      },
    }),
    [],
  );

  // The add host ports (id minting / ring ids / the U13 process-start adapter).
  // The U13 adapter is the documented dependency seam (spec §依存 U13): until the
  // consistency host unit is wired it returns a deterministic rejection so a save
  // surfaces a Japanese message instead of silently doing nothing — the COMPLETE
  // and SAVE triggers are fully配線 either way (教訓 5.7).
  const hostBootstrap = useMemo(() => createAddBootstrap<DomainRoot>(), []);

  return (
    <div id="app-shell">
      <AppShell
        store={store}
        onMapMount={onMapMount}
        overlay={
          <AddToolController<DomainRoot>
            store={store}
            startProcess={hostBootstrap.startProcess}
            ids={hostBootstrap.ids}
            nextRingId={hostBootstrap.nextRingId}
            screenToWorld={screenToWorld}
            drawSink={drawSink}
          />
        }
      />
    </div>
  );
}

// --- The add bootstrap (id ports + the U13 seam) ----------------------------

import {
  createIdGeneratorState,
  nextRawId,
  type IdGeneratorState,
} from '../domain/id-generator';
import { asFeatureId, asRingId, asVertexId } from '../domain/ids';
import {
  PROCESS_STATUS,
  REJECTION_KIND,
  type ProcessResult,
} from '../domain/consistency/index';
import type { AddIdPorts } from '../domain/add/index';
import type { StartAddProcess } from './add/useAddTool';

interface AddBootstrap<S> {
  readonly ids: AddIdPorts;
  readonly nextRingId: () => ReturnType<typeof asRingId>;
  readonly startProcess: StartAddProcess<S>;
}

function createAddBootstrap<S>(): AddBootstrap<S> {
  // A monotonic id generator seeded from a stable counter (deterministic; the
  // real host swaps in U03's nextRawId over the live state). The time source is
  // injected as a monotonic counter so ids never collide within a tick (教訓 5.37).
  let state: IdGeneratorState = createIdGeneratorState();
  let tick = 0;
  const mint = (prefix: string): string => {
    const g = nextRawId(prefix, state, () => (tick += 1), new Set());
    state = g.state;
    return g.value;
  };
  const ids: AddIdPorts = {
    nextFeatureId: () => asFeatureId(mint('f')),
    nextVertexId: () => asVertexId(mint('v')),
  };
  const nextRingId = (): ReturnType<typeof asRingId> => asRingId(mint('r'));

  // The U13 dependency seam (spec §依存: 依存ユニットが未実装の場合は契約に沿って
  // 実装し、後で差し替える). Returns a deterministic rejection so the SAVE trigger
  // is observably wired (a Japanese message appears) until the consistency host
  // is connected. Replacing this closure connects the real U13 orchestrator with
  // no change to the controller (教訓 5.33 契約越し).
  const startProcess: StartAddProcess<S> = (): ProcessResult<S> => ({
    status: PROCESS_STATUS.Rejected,
    kind: REJECTION_KIND.Internal,
    message: '整合性維持プロセスがまだ接続されていません。',
  });

  return { ids, nextRingId, startProcess };
}

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
import {
  KnifeToolController,
  type KnifeDrawSink,
} from './knife/index';
import type { DrawPrimitive } from '../render/map-renderer';
import { createColorInfo } from '../domain/attributes';

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
  const knifeDrawSink: KnifeDrawSink = useMemo(
    () => ({
      drawKnife(primitives: readonly DrawPrimitive[]): void {
        rendererRef.current?.drawKnife(primitives);
      },
    }),
    [],
  );

  // The add host ports (id minting / ring ids / the U13 process-start adapter).
  //
  // DEPENDENCY SEAM — U13 NOT YET LIVE-BOUND (spec §依存 U13; DECISIONS D16-D19):
  // `startProcess` below is a deterministic-rejection STUB, not the real U13
  // orchestrator. As a result the live synthesis CANNOT yet reach the committed
  // outcome: 受け入れ基準1(現在時刻錨として確定), 基準2(確定済み分岐), and 基準9
  // (完了後の選択再解決) hold ONLY against an injected U13 in the U23 unit tests
  // (AddToolController.test.tsx / useAddTool.test.tsx) — in the shipped composite
  // a SAVE always ends in the Japanese rejection message. This is intentional and
  // honestly scoped: the COMPLETE and SAVE triggers are fully配線 (教訓 5.7) and
  // observable, but the CONFIRM path is deliberately left open until U42 binds the
  // real orchestrator. The controller takes `startProcess` as a contract
  // (StartAddProcess<S>), so U42 connects the live U13 by REPLACING this single
  // closure with `consistency/orchestrator.ts#startProcess` bound over the live
  // domain root — no change to AddToolController / useAddTool (教訓 5.33 契約越し).
  //
  // U42 BINDING POINT (see createAddBootstrap below): swap the stub for
  //   (proposal) => startConsistencyProcess(liveDomainRoot, toEditProposal(proposal), livePorts)
  // and feed the Committed/ConflictsPending/Rejected result back unchanged.
  const hostBootstrap = useMemo(() => createAddBootstrap<DomainRoot>(), []);

  // U26 INTEGRATION (教訓 5.7 / 5.2): the knife-tool controller is mounted in the
  // SAME shell overlay, bound to the SAME store, so selecting 編集モード→ナイフ starts
  // a session, map-input clicks drive対象面選択 / 分断線入力 / 閉線確定, the继承先 modal +
  // U23 form re-use drive継承先選択 / 非継承側プロパティ入力, and 確定 hands a split
  // EditProposal to the U13 seam. Like the add seam, U13 is a deterministic stub
  // until U42 binds the live orchestrator (教訓 5.33 契約越し). The domain-lookup
  // ports (resolveFeature / resolveStore / featureAtPoint) are honest stubs over the
  // empty scaffold root until a load + selection unit supplies the live domain — the
  // WIRING is real and observable; the geometry path activates when those ports do.
  const knifeBootstrap = useMemo(() => createKnifeBootstrap<DomainRoot>(), []);

  return (
    <div id="app-shell">
      <AppShell
        store={store}
        onMapMount={onMapMount}
        overlay={
          <>
            <AddToolController<DomainRoot>
              store={store}
              startProcess={hostBootstrap.startProcess}
              ids={hostBootstrap.ids}
              nextRingId={hostBootstrap.nextRingId}
              screenToWorld={screenToWorld}
              drawSink={drawSink}
            />
            <KnifeToolController<DomainRoot>
              store={store}
              startProcess={knifeBootstrap.startProcess}
              ids={knifeBootstrap.ids}
              resolveFeature={knifeBootstrap.resolveFeature}
              resolveStore={knifeBootstrap.resolveStore}
              anchorTime={() => store.getState().currentTime}
              screenToWorld={screenToWorld}
              featureAtPoint={knifeBootstrap.featureAtPoint}
              targetShape={undefined}
              drawSink={knifeDrawSink}
              zoom={rendererRef.current?.zoom() ?? 1}
              defaultColor={KNIFE_DEFAULT_COLOR}
            />
          </>
        }
      />
    </div>
  );
}

/** A sensible default color for a non-inherited split feature (FR-97 auto-color on). */
const KNIFE_DEFAULT_COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

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
  // is connected.
  //
  // U42 BINDING POINT: replace this closure with the real U13 orchestrator —
  //   import { startProcess as startConsistencyProcess } from '../domain/consistency/index';
  //   const startProcess: StartAddProcess<S> = (proposal) =>
  //     startConsistencyProcess(liveDomainRoot, toEditProposal(proposal), liveConsistencyPorts);
  // The controller consumes StartAddProcess<S> as a contract, so this is the only
  // line U42 must change to make 基準1/2-Committed/9 reachable in the live
  // composite (教訓 5.33 契約越し). Until then the CONFIRM path is open by design
  // (DECISIONS D16-D19; U23 acceptanceMet=false 部分充足).
  const startProcess: StartAddProcess<S> = (): ProcessResult<S> => ({
    status: PROCESS_STATUS.Rejected,
    kind: REJECTION_KIND.Internal,
    message: '整合性維持プロセスがまだ接続されていません。',
  });

  return { ids, nextRingId, startProcess };
}

// --- The knife bootstrap (id ports + domain-lookup stubs + the U13 seam) -----

import { createVertexStore, type VertexStore } from '../domain/vertex';
import type { Feature } from '../domain/feature';
import type { FeatureId } from '../domain/ids';
import type {
  ResolveFeature,
  ResolveVertexStore,
  StartSplitProcess,
  FeatureAtPoint,
} from './knife/index';
import type { SplitIdPorts } from '../domain/knife/index';

interface KnifeBootstrap<S> {
  readonly ids: SplitIdPorts;
  readonly resolveFeature: ResolveFeature;
  readonly resolveStore: ResolveVertexStore;
  readonly featureAtPoint: FeatureAtPoint;
  readonly startProcess: StartSplitProcess<S>;
}

function createKnifeBootstrap<S>(): KnifeBootstrap<S> {
  // Deterministic monotonic id minting (same discipline as the add bootstrap;
  // 教訓 5.37). U03's nextRawId over the live state replaces this in the live host.
  let state: IdGeneratorState = createIdGeneratorState();
  let tick = 0;
  const mint = (prefix: string): string => {
    const g = nextRawId(prefix, state, () => (tick += 1), new Set());
    state = g.state;
    return g.value;
  };
  const ids: SplitIdPorts = {
    nextFeatureId: () => asFeatureId(mint('f')),
    nextVertexId: () => asVertexId(mint('v')),
    nextRingId: () => asRingId(mint('r')),
  };

  // Domain-lookup ports: honest stubs over the empty scaffold root. A load +
  // selection unit (U22/U08 + persistence) replaces these with live lookups; until
  // then no feature resolves, so対象面選択 finds nothing — the WIRING is real and the
  // overlay / guide are observable, while the geometry path activates with the data.
  const emptyStore: VertexStore = createVertexStore([]);
  const resolveFeature: ResolveFeature = (): Feature | undefined => undefined;
  const resolveStore: ResolveVertexStore = (): VertexStore => emptyStore;
  const featureAtPoint: FeatureAtPoint = (): FeatureId | null => null;

  // The U13 dependency seam — same deterministic rejection as the add seam until
  // U42 binds the live orchestrator (教訓 5.33 契約越し).
  //
  // U42 BINDING POINT: replace this closure with
  //   (proposal) => startConsistencyProcess(liveDomainRoot, proposal, liveConsistencyPorts)
  // The proposal is ALREADY a U13 EditProposal<SplitSnapshot> (toEditProposal ran in
  // the hook), so this is the only line U42 changes for the split CONFIRM path.
  const startProcess: StartSplitProcess<S> = (): ProcessResult<S> => ({
    status: PROCESS_STATUS.Rejected,
    kind: REJECTION_KIND.Internal,
    message: '整合性維持プロセスがまだ接続されていません。',
  });

  return { ids, resolveFeature, resolveStore, featureAtPoint, startProcess };
}

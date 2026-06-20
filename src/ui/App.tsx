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

import { useCallback, useMemo, useRef, useState } from 'react';

import { createSessionStore } from './state/store';
import { AppShell } from './shell';
import { Timeline } from './timeline/Timeline';
import { CommandRegistry } from './shell/commands';
import './shell/shell.css';
import './file-ops/file-ops.css';

import { getCalendar } from '../domain/time/calendar';
import type { DomainProject } from '../domain/persistence/index';
import {
  FileOpsController,
  buildEmptyProject,
  type SupplyZoomRange,
  type WindowCloseHook,
  type DropTargetHook,
  type FileDropHandlers,
} from './file-ops/index';
import type { ZoomRange } from '../render/camera';

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

// The domain truth root is U14's persistence {@link DomainProject} (histories +
// settings + base-map). U39 wires file-ops to load / save / repair it; the shell
// and the add / knife controllers stay generic over it and never reach inside
// (spec 依存: ルート状態を不変に受け渡す).
type DomainRoot = DomainProject;

export function App(): JSX.Element {
  // Bootstrap with an empty NEW project (地物 0 件 + 出界図 preset background,
  // FR-03 / spec §D). The file-ops controller re-initialises this atomically on
  // 新規プロジェクト and replaces it wholesale on 読み込み (教訓 5.22 / 5.36).
  const store = useMemo(
    () => createSessionStore<DomainRoot>({ initialDomain: buildEmptyProject() }),
    [],
  );

  // The U20 command registry: the ファイル menu / shortcuts dispatch through it.
  // Created here and shared with BOTH the shell (so the menu binds it) and the
  // file-ops controller (so it registers the save/open/new commands, 教訓 5.13).
  const registry = useMemo(() => new CommandRegistry(), []);

  // The active calendar for U14 load-time consistency checks (FR-106).
  const calendar = useMemo(() => getCalendar('gregorian'), []);

  // Window-close interception (FR-107 終了確認ガード): the controller registers the
  // quit guard; the host stores it so a later shell-side close event can await it.
  // Until the Electron close event is bridged (shell seam), the runner is held
  // here so the contract is real and the guard logic is observable / testable.
  const quitGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerWindowClose: WindowCloseHook = useCallback((runGuard) => {
    quitGuardRef.current = runGuard;
    return () => {
      quitGuardRef.current = null;
    };
  }, []);

  // D&D 読み込み (FR-105): the file-ops controller exposes the drop handlers; we bind
  // them on the app-shell ROOT, which is pointer-active and an ancestor of the map
  // area, so a real-browser drop (Electron Chromium) over the map bubbles up here
  // and reaches the load flow. The controller's own overlay container is
  // pointer-events:none (教訓 5.14) and therefore cannot be the real drop target.
  const [dropHandlers, setDropHandlers] = useState<FileDropHandlers | null>(null);
  const registerDropTarget: DropTargetHook = useCallback((handlers) => {
    setDropHandlers(handlers);
    return () => setDropHandlers(null);
  }, []);

  // The live renderer is created imperatively on map mount (技術方針 2.3); we hold
  // it behind a ref so the add-tool ports read the current renderer without riding
  // a React re-render. Until the map mounts the ports degrade gracefully (no-op
  // draw / identity transform), so the wiring is real and never crashes pre-mount.
  const rendererRef = useRef<AddHostPorts | null>(null);

  // The latest zoom CLAMP range (FR-10). The file-ops controller pushes it on
  // every settings change; we cache it so a range set BEFORE the map mounts is
  // applied as soon as the renderer exists (no lost update, 教訓 5.22).
  const zoomRangeRef = useRef<ZoomRange | null>(null);

  const onMapMount = useCallback((el: HTMLDivElement): (() => void) => {
    const ports = createAddHostPorts(el);
    rendererRef.current = ports;
    // Apply any clamp range supplied before mount (FR-10 即時反映).
    if (zoomRangeRef.current !== null) ports.setZoomRange(zoomRangeRef.current);
    return () => {
      ports.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Supply the camera clamp range to U17 (FR-10 / FR-109 即時反映). Caches the
  // value and forwards it to the live renderer when one is mounted.
  const supplyZoomRange: SupplyZoomRange = useCallback((range) => {
    zoomRangeRef.current = range;
    rendererRef.current?.setZoomRange(range);
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
  // a SAVE always ends in the Japanese rejection message. The COMPLETE and SAVE
  // triggers are fully配線 (教訓 5.7) and observable; only the CONFIRM path is open.
  //
  // BINDING COST — NOT a「1行差し替え」(integration-lens correction): connecting the
  // live U13 is NOT swapping this one closure. It requires building a full
  // `ConsistencyPorts<DomainRoot, AddSnapshot>` adapter (U09 time / U10 spatial /
  // U06 difference / U12 single-undo) bound over the live domain root, PLUS an
  // `applyProposal` that materialises an AddSnapshot into a `DomainProject` history
  // anchor. The factory shape + per-port duties are pinned in
  // `./consistency-binding.ts` (LiveConsistencyBinding / CreateLiveAddBinding); the
  // controller consumes `StartAddProcess<S>` as a contract (教訓 5.33 契約越し), so
  // ONCE that binding exists App.tsx replaces the stub with
  // `createLiveAddBinding({ getRoot }).startProcess` — no change to the controller.
  //
  // OWNERSHIP — UNASSIGNED, NOT U42 (開発ガイド §1.8): `applyProposal` is a NEW
  // domain operation (snapshot → anchor → history insert) that no shipped unit
  // exposes. It is new domain work, so it cannot belong to U42 (U42「やらないこと」=
  // 新規ドメイン機能の実装 — U42 is verification-only). Recorded as an unassigned
  // open item requiring a planned unit in docs/現状.md.
  const hostBootstrap = useMemo(
    () => createAddBootstrap<DomainRoot>(() => store.getState().domain),
    [store],
  );

  // U26 INTEGRATION (教訓 5.7 / 5.2): the knife-tool controller is mounted in the
  // SAME shell overlay, bound to the SAME store, so selecting 編集モード→ナイフ starts
  // a session, map-input clicks drive対象面選択 / 分断線入力 / 閉線確定, the继承先 modal +
  // U23 form re-use drive継承先選択 / 非継承側プロパティ入力, and 確定 hands a split
  // EditProposal to the U13 seam. Like the add seam, U13 is a deterministic stub;
  // the live binding (`CreateLiveKnifeBinding` in ./consistency-binding.ts) is the
  // SAME non-trivial `ConsistencyPorts<DomainRoot, SplitSnapshot>` adapter cost, and
  // its `applyProposal` is the SAME unassigned new-domain blocker (NOT U42; 開発ガイド
  // §1.8, docs/現状.md). The domain-lookup ports (resolveFeature / resolveStore /
  // featureAtPoint) are honest stubs over the empty scaffold root until a load +
  // selection unit supplies the live domain — the WIRING is real and observable; the
  // geometry path activates when those ports do.
  const knifeBootstrap = useMemo(
    () => createKnifeBootstrap<DomainRoot>(() => store.getState().domain),
    [store],
  );

  // KNIFE COMMIT (C3 — 教訓 5.11): KnifeToolController defaults onCommitted to a
  // NOOP, so its committed result was previously DROPPED. Wire it to the single
  // store-write path: replay the U12 command against the pre-commit domain to
  // derive the CommandResult, swap in the committed DomainProject, and promote the
  // inheritor (SplitSnapshot.touchedFeatureIds[0]) so selection re-resolves to it
  // rather than blanket-clearing (FR-94 / split-after selection retention).
  const onKnifeCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, snapshot: SplitSnapshot) => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      const commandResult = result.command.execute(store.getState().domain).result;
      const inheritorId = snapshot.touchedFeatureIds[0] ?? snapshot.inheritorFeatureId;
      store.getState().applyCommandResult(result.state, commandResult, {
        featureId: inheritorId,
      });
    },
    [store],
  );

  return (
    <div
      id="app-shell"
      onDragOver={dropHandlers?.onDragOver}
      onDrop={dropHandlers?.onDrop}
    >
      <AppShell
        store={store}
        registry={registry}
        onMapMount={onMapMount}
        timeline={<Timeline store={store} />}
        overlay={
          <>
            {/* U39 INTEGRATION (受け入れ基準 1-6): the file-ops controller registers
                the ファイル menu / shortcut commands on the SAME registry the shell
                dispatches, drives the FR-107 unsaved warning + FR-106 repair modals,
                reflects loaded / repaired projects into the store, supplies the
                FR-10 zoom clamp range to U17, and intercepts window-close with the
                quit guard. All file I/O routes through U15's typed IPC
                (window.timeMapApi); the renderer never touches fs (FR-02). */}
            <FileOpsController
              store={store}
              registry={registry}
              calendar={calendar}
              supplyZoomRange={supplyZoomRange}
              registerWindowClose={registerWindowClose}
              registerDropTarget={registerDropTarget}
            />
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
              onCommitted={onKnifeCommitted}
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
  type ProcessResult,
} from '../domain/consistency/index';
// U44 — the LIVE U13 binding factories (no longer a 型骨格): these build the real
// ConsistencyPorts<DomainRoot, Snapshot> adapter over the live domain root and
// expose the `startProcess` closure the controllers consume (./consistency-binding.ts).
import {
  createLiveAddBinding,
  createLiveKnifeBinding,
} from './consistency-binding';
import type { AddIdPorts } from '../domain/add/index';
import type { StartAddProcess } from './add/useAddTool';

// Pin, at the type level, the live binding factory contracts (教訓 5.33 契約越し):
// the composition-root swap is contract-clean — the controllers consume only the
// produced `startProcess`, so the binding body is the only thing that changed.
export type LiveAddBindingFactory = typeof createLiveAddBinding;
export type LiveKnifeBindingFactory = typeof createLiveKnifeBinding;

interface AddBootstrap<S> {
  readonly ids: AddIdPorts;
  readonly nextRingId: () => ReturnType<typeof asRingId>;
  readonly startProcess: StartAddProcess<S>;
}

function createAddBootstrap<S>(getRoot: () => S): AddBootstrap<S> {
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

  // U44 — the LIVE U13 binding. `createLiveAddBinding` builds the full
  // ConsistencyPorts<DomainRoot, AddSnapshot> adapter (applyProposal = U44's
  // applyAddProposal; U09 time / U10 spatial / U06 difference / U12 single-undo)
  // over the live root read at process-start (getRoot, never a stale capture —
  // 教訓 5.6). The controller consumes StartAddProcess<S> as a contract (教訓 5.33);
  // the swap is contract-clean. The bootstrap's id ports back the U06 resolution
  // write-back ring/vertex minting. The binding is generic over the domain root S
  // (here always DomainProject), matching the controller's StartAddProcess<S>.
  const live = createLiveAddBinding({
    getRoot: getRoot as unknown as () => DomainRoot,
    nextVertexId: ids.nextVertexId,
    nextRingId,
  });
  const startProcess = live.startProcess as unknown as StartAddProcess<S>;

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
import type { SplitIdPorts, SplitSnapshot } from '../domain/knife/index';

interface KnifeBootstrap<S> {
  readonly ids: SplitIdPorts;
  readonly resolveFeature: ResolveFeature;
  readonly resolveStore: ResolveVertexStore;
  readonly featureAtPoint: FeatureAtPoint;
  readonly startProcess: StartSplitProcess<S>;
}

function createKnifeBootstrap<S>(getRoot: () => S): KnifeBootstrap<S> {
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

  // U44 — the LIVE U13 binding for split. `createLiveKnifeBinding` builds the full
  // ConsistencyPorts<DomainRoot, SplitSnapshot> adapter (applyProposal = U44's
  // applySplitProposal: inheritor shape past-edit + non-inherited new history; +
  // U09/U10/U06/U12) over the live root read at process-start (getRoot). The
  // proposal is ALREADY a U13 EditProposal<SplitSnapshot> (toEditProposal ran in
  // the hook), so the swap is contract-clean. The domain-lookup ports above
  // (resolveFeature / resolveStore / featureAtPoint) still need a live selection
  // unit before対象面選択 finds geometry; the CONFIRM path is wired regardless.
  const live = createLiveKnifeBinding({
    getRoot: getRoot as unknown as () => DomainRoot,
    nextVertexId: ids.nextVertexId,
    nextRingId: ids.nextRingId,
  });
  const startProcess = live.startProcess as unknown as StartSplitProcess<S>;

  return { ids, resolveFeature, resolveStore, featureAtPoint, startProcess };
}

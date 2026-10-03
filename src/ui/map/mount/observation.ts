// UI 層（地図マウントの結線 / 観測）: HB-1 の観測フックだけを組み立てる。
//
// ここが持つのは「見えているものを外から読めるようにする鏡」だけで、真実は 1 つも持たない
// （技術方針 2.5）。取り付け先（`hookTarget` / `mapCell`）の解決規則も、E2E が読む
// `data-zoom` / `data-pan-x` / `data-pan-y` の置き場も、分割前と 1 ビットも変えていない。

import type { MutableRefObject } from 'react';

import type { AddHostPorts } from '../../add/host-ports';
import {
  ABSENT_LANE_STATS,
  ABSENT_RAIL_VIEW,
  readRailObservation,
  type AnchorLaneStats,
  type RailViewSnapshot,
} from '../../e2e/rail-observation';
import { buildCommittedFeatures, drawnFeatureFills } from '../committed-features';
import { featureByIdAt, verticesAt } from '../../live-lookup';
import { asFeatureId } from '../../../domain/ids';
import { referencedVertexIds } from '../../../domain/feature';
import { getVertex } from '../../../domain/vertex';
import type { Camera as RenderCamera } from '../../../render/camera';
import type { MountStore } from './shared';

// HB3-9 RENDER OBSERVATION HOOK (__E2E__). The bughunt lesson "Behavioral E2E
// standard" requires tests that observe the actual RENDER so a render-only bug
// (handles never drawn) is detectable from a real pointer-driven test — a synthetic
// shortcut cannot see it. We expose a small read-only window hook that mirrors (a)
// the live active feature id, (b) the live active tool id (the toolbar's aria-pressed
// tool), (c) the per-kind primitive counts of the LAST drawn frame (handle / label /
// preview / shape / point / line), and (d) whether a live tool preview is present.
// It holds NO truth — pure mirrors of the store + the last composed frame (技術方針
// 2.5). `frame` is updated by the host's onFrameComposed below.
export type E2EFrameSummary = {
  handle: number;
  label: number;
  shape: number;
  point: number;
  line: number;
  /** FR-82 点線アウトライン (頂点選択コンテキスト地物) drawn this frame. */
  dashedLine: number;
  preview: number;
  hasLivePreview: boolean;
  vertexHandlePositions: readonly { readonly lon: number; readonly lat: number }[];
};

/** {@link createMountObservation} の入力。 */
export interface MountObservationOptions {
  /** 地図キャンバスのマウント先（AppShell が `onMapMount` に渡す div）。 */
  readonly el: HTMLDivElement;
  /** 観測が写す唯一の U16 セッションストア。 */
  readonly store: MountStore;
  /** 生きているレンダラ（`__E2E__.screenToWorld` が読む）。 */
  readonly rendererRef: MutableRefObject<AddHostPorts | null>;
}

/** {@link createMountObservation} の産物。 */
export interface MountObservation {
  /** HB-1 観測フックと pointer/wheel リスナーの取り付け先（地図入力層）。 */
  readonly hookTarget: HTMLElement;
  /** 地図セル（.map-area）。FR-111 のカーソル読み取りはここに付く。 */
  readonly mapCell: HTMLElement;
  /** ライブカメラを観測フック（pan/zoom）とストアへ写す。 */
  readonly publishCameraHooks: (camera: RenderCamera) => void;
  /** HB-14 — このフレームで見えた地物数を写す。 */
  readonly publishVisibleCountHook: (count: number) => void;
  /** HB3-9 — 直前に描いたフレームの内訳を `__E2E__` へ写す。 */
  readonly publishFrameHook: (summary: E2EFrameSummary) => void;
  /** 後始末（`__E2E__` の取り外し）。 */
  readonly dispose: () => void;
}

/**
 * HB-1 / HB-14 / HB3-9 の観測フックを取り付ける。取り付け先の解決（`hookTarget` /
 * `mapCell`）もここが持つ: どちらもレンダラより先に決まっている必要があり
 * （`createAddHostPorts` は最初の描画で同期に `onCameraChange` を呼ぶ）、入力側も
 * 同じ 2 つの要素へリスナーを張るので、解決の規則は 1 か所に置く。
 */
export function createMountObservation(
  options: MountObservationOptions,
): MountObservation {
  const { el, store, rendererRef } = options;

  // HB-1 観測フック target. Resolved BEFORE the renderer is created because
  // `createAddHostPorts` fires `onCameraChange` synchronously on its initial paint
  // (to seed the hooks) — referencing `hookTarget` from inside that callback before
  // it exists would be a temporal-dead-zone ReferenceError that crashes the mount.
  // The pointer/wheel listeners attach to the map INPUT layer (教訓 5.14); if it is
  // not present yet (defensive) we fall back to the canvas mount element.
  const inputLayer = el.parentElement?.querySelector<HTMLElement>(
    '[data-testid="map-input-layer"]',
  );
  const hookTarget: HTMLElement = inputLayer ?? el;

  // The map CELL (.map-area) — the ANCESTOR of the canvas mount, the input layer AND the
  // overlay layer. The FR-111 cursor readout hooks HERE, not on the input layer (review
  // fix): a tool input bridge (追加 / 切断 / 併合 / 再所属 / 測量) is a SIBLING of the input
  // layer that sits ABOVE it, so a move over a bridge never reaches the input layer and
  // entering a bridge fires the input layer's own `pointerleave` — the readout went blank
  // in exactly the modes that need coordinates most (測量 = FR-16, 作図). A move over ANY
  // of those layers bubbles to the cell, and the cell's `pointerleave` fires only when the
  // pointer really leaves the map cell, so 「地図の上か否か」is judged once against the map
  // region itself. A new tool overlay is covered automatically (no per-tool 結線 to forget,
  // 教訓 5.7 部分結線禁止).
  const mapCell: HTMLElement = el.parentElement ?? hookTarget;

  /** Reflect the live camera into the observation hooks (pan offset + zoom). */
  const publishCameraHooks = (camera: RenderCamera): void => {
    // Pan offset is the camera center displacement from the FR-11 origin (0,0);
    // a drag changes it, so the E2E reads a before/after delta. Zoom is verbatim.
    hookTarget.dataset['panX'] = String(camera.centerLon);
    hookTarget.dataset['panY'] = String(camera.centerLat);
    hookTarget.dataset['zoom'] = String(camera.zoom);
    // ROOT FIX (bughunt: Knife の固定円半径/閉線判定が初期 zoom のまま stale) — mirror
    // EVERY live render-camera change into the U16 store camera truth (技術方針 2.5:
    // camera STATE is owned by the session store). This is the SINGLE mirror path
    // for ALL camera changes — the FR-11 fit-all on first paint, the zero-size→
    // measured re-fit, AND every pan/wheel through writeCamera — so subscribers that
    // bind to store.camera (the U26 knife 固定円半径 / 閉線判定 zoom prop) always see
    // the renderer's TRUE zoom, never the DEFAULT_CAMERA.zoom=1 placeholder that
    // diverges from the actual fit zoom until the first interaction (二重真実源を
    // 作らない, 教訓 5.29). Only the three transform fields the render camera carries
    // are patched (the store Camera additionally has panX/panY).
    const s = store.getState();
    const cur = s.camera;
    // ONE store transition per camera change: `updateCamera` mirrors `centerLon`
    // into the top-level FR-12 longitude truth within the SAME set() (store.ts),
    // so a live pan / wheel — the hottest path — fires the subscription once, not
    // twice (updateCamera + setCenterLon). The guard also covers the centerLon
    // mirror: if camera fields are unchanged then centerLon (== camera.centerLon)
    // is too, so there is nothing to write.
    if (
      cur.zoom !== camera.zoom ||
      cur.centerLon !== camera.centerLon ||
      cur.centerLat !== camera.centerLat
    ) {
      s.updateCamera({
        zoom: camera.zoom,
        centerLon: camera.centerLon,
        centerLat: camera.centerLat,
      });
    }
  };

  /**
   * HB-14 観測フック: mirror the count of committed features that SURVIVED the
   * period-aware view clip on the latest composite into `data-visible-feature-count`
   * (既存 app-active-feature 方式). A behavioural E2E commits one area, then zooms in
   * step by step and asserts this count never wrongly drops to 0 while the feature
   * is still on screen (拡大すると地物が消える 再発防止). Holds NO truth — pure mirror.
   */
  const publishVisibleCountHook = (count: number): void => {
    hookTarget.dataset['visibleFeatureCount'] = String(count);
  };

  let lastFrame: E2EFrameSummary = {
    handle: 0,
    label: 0,
    shape: 0,
    point: 0,
    line: 0,
    dashedLine: 0,
    preview: 0,
    hasLivePreview: false,
    vertexHandlePositions: [],
  };
  const e2eWindow = el.ownerDocument.defaultView as (Window & {
    __E2E__?: unknown;
  }) | null;
  if (e2eWindow !== null) {
    e2eWindow.__E2E__ = {
      /** The live active feature id ('' when none). */
      getActiveFeature: (): string =>
        (store.getState().activeFeature as unknown as string | null) ?? '',
      /** The live active tool id ('' when none) — the toolbar's aria-pressed tool. */
      getActiveTool: (): string =>
        (store.getState().activeTool as unknown as string | null) ?? '',
      /** The live interaction mode ('view' / 'add' / 'edit'). */
      getMode: (): string => store.getState().mode,
      /** Per-kind primitive counts of the LAST drawn frame (handle/label/shape/point/line). */
      getPrimitiveCounts: (): E2EFrameSummary => ({ ...lastFrame }),
      /** Whether a live tool preview (FR-78 仮表示 overlay) is present this frame. */
      hasLivePreview: (): boolean => lastFrame.hasLivePreview,
      /**
       * FR-42 / FR-43: the number of DISTINCT features currently drawn, resolved
       * through the SAME U34 display pipeline the map draws (buildCommittedFeatures
       * with the live displayControl). A global-depth change rolls features up into
       * their aggregate (fewer) or expands them into children (more), so a behavioural
       * E2E asserts this count changes when the 階層深度 slider moves — the observable
       * proof the depth UI is wired to the display resolution. Distinct feature ids
       * (not primitive count) so a multipolygon aggregate counts as ONE feature.
       */
      getDrawnFeatureCount: (): number => {
        const s = store.getState();
        const drawn = buildCommittedFeatures(
          s.domain,
          s.currentTime,
          s.activeFeature,
          s.displayControl,
          // FR-113: the count reflects the display filter too (面オフ → fewer drawn),
          // so the display-filter E2E asserts the count changes on a kind/depth toggle.
          s.filter,
        );
        return new Set(drawn.map((f) => f.id)).size;
      },
      /**
       * FR-113 Phase 2: the color each drawn feature is ACTUALLY PAINTED with, keyed by
       * feature id — resolved through the SAME buildCommittedFeatures the map draws (live
       * filter included) and the renderer's OWN `activeColor` rule (`style.selectedColor`
       * when the feature is highlighted, else the fill). The FR-113 opacity is BAKED into
       * the string (`#rrggbb` when fully opaque, `rgba(…)` once dimmed), so a behavioural
       * E2E can prove「強調した地物以外が淡くなる」from the REAL draw batch rather than from
       * the store — AND can see a regression that repaints an emphasized feature in the
       * selection colour (a `style.fill` mirror never could). Read-only observation; the
       * mapping itself is the Vitest-pinned pure `drawnFeatureFills`.
       */
      getDrawnFeatureFills: (): Record<string, string> => {
        const s = store.getState();
        return drawnFeatureFills(
          buildCommittedFeatures(
            s.domain,
            s.currentTime,
            s.activeFeature,
            s.displayControl,
            s.filter,
          ),
        );
      },
      /**
       * HB3-4: the WORLD positions of the active feature's VERTEX edit-handles in the
       * LAST drawn frame (preview positions during a live drag). A behavioural E2E
       * asserts the dragged handle follows the cursor mid-drag and does NOT jump back
       * to the committed position after release.
       */
      getVertexHandlePositions: (): readonly {
        readonly lon: number;
        readonly lat: number;
      }[] => lastFrame.vertexHandlePositions.map((p) => ({ lon: p.lon, lat: p.lat })),
      /**
       * HB3-4: convert a CLIENT screen point to a world coordinate via the LIVE
       * renderer inverse (the SAME transform the draw / hit-test use). Lets the drag
       * E2E identify WHICH committed handle corresponds to a known screen corner,
       * independent of the camera. Returns null before the renderer mounts.
       */
      screenToWorld: (
        clientX: number,
        clientY: number,
      ): { readonly lon: number; readonly lat: number } | null =>
        rendererRef.current?.screenToWorld(clientX, clientY) ?? null,
      /**
       * 増分 8A の手直し（GPT #3）: いま見ている年の **確定済みの** 地物 `featureId` が引いて
       * いる頂点を、id と座標で返す（頂点の印には id が無いので、「どの頂点が動いたか」を
       * id で照合するための口）。引けなければ空。
       */
      getCommittedVertices: (
        featureId: string,
      ): readonly { readonly id: string; readonly lon: number; readonly lat: number }[] => {
        const s = store.getState();
        const feature = featureByIdAt(s.domain, s.currentTime, asFeatureId(featureId));
        if (feature === undefined) return [];
        const vertices = verticesAt(s.domain, s.currentTime);
        const out: { id: string; lon: number; lat: number }[] = [];
        for (const id of referencedVertexIds(feature)) {
          const v = getVertex(vertices, id);
          if (v !== undefined) out.push({ id: String(id), lon: v.coordinate.lon, lat: v.coordinate.lat });
        }
        return out;
      },
      /** 増分 8A の手直し: いま選んでいる頂点の id の全部（`app-active-vertex` は 1 つしか出さない）。 */
      getSelectedVertexIds: (): readonly string[] =>
        [...store.getState().selection.vertexIds].map(String),
      /**
       * 増分 6 の中身 8: **時刻レールの観測 3 口**。実体はレールが
       * `ui/e2e/rail-observation.ts` の登録簿へ置き、ここは読むだけである
       * （`__E2E__` を生やす書き手を 1 つに保つため。同 module の見出しを参照）。
       * レールがまだ載っていない瞬間でも **口そのものは生やす** ―― 口の有無で
       * 検査が分岐すると「観測できないのか、値が 0 なのか」が区別できなくなる。
       */
      getAnchorLaneStats: (): AnchorLaneStats =>
        readRailObservation()?.getAnchorLaneStats() ?? ABSENT_LANE_STATS,
      getAnchorMarkPositions: (): readonly number[] =>
        readRailObservation()?.getAnchorMarkPositions() ?? [],
      getRailView: (): RailViewSnapshot =>
        readRailObservation()?.getRailView() ?? ABSENT_RAIL_VIEW,
      /**
       * 増分 8E の手直し（GPT 重 2）: いま地図に描いている **面の形**（id → 片ごとの環の
       * 経度・緯度）。描画と同じ `buildCommittedFeatures` を通る。重なり解決の E2E が
       * 「適用で重なりが消え、残す側の形はそのまま、Ctrl+Z で編集の前の形へ戻る」を
       * 形そのもので確かめるための読むだけの口。
       */
      getDrawnFeatureShapes: (): Record<string, number[][][][]> => {
        const s = store.getState();
        const out: Record<string, number[][][][]> = {};
        for (const f of buildCommittedFeatures(
          s.domain,
          s.currentTime,
          s.activeFeature,
          s.displayControl,
          s.filter,
        )) {
          if (f.kind !== 'area') continue;
          out[f.id] = f.shape.map((piece) => piece.map((ring) => ring.map((c) => [c.lon, c.lat])));
        }
        return out;
      },
    };
  }

  /** HB3-9: mirror the last composed frame's primitive summary into the __E2E__ hook. */
  const publishFrameHook = (summary: E2EFrameSummary): void => {
    lastFrame = summary;
  };

  const dispose = (): void => {
    // HB3-9: drop the render-observation hook so a remount re-installs a fresh one
    // bound to the new renderer (no stale closure over the disposed host).
    if (e2eWindow !== null && '__E2E__' in e2eWindow) {
      delete (e2eWindow as { __E2E__?: unknown }).__E2E__;
    }
  };

  return {
    hookTarget,
    mapCell,
    publishCameraHooks,
    publishVisibleCountHook,
    publishFrameHook,
    dispose,
  };
}

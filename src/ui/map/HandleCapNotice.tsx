// UI layer (地図): 頂点の印が上限のせいで出ていないときに、理由と［拡大］をオプションバーの
// 「次の一手」へ押し込む（増分 8A の中身 3 / 設計書 §E.1 V9・§H.5）。
//
// **描画するものは無い**（`null` を返す）。帯の見た目は `OptionBar.tsx` が持ち、ここは
// 押し込むだけの配線である（`ToolOptionBar` と同じ作法）。
//
// - **出す条件は印を描く条件と同じ**（教訓 5.30）: 鍵が開いていて、掴める道具（選ぶ・頂点・
//   動かす）を構えていて、選んでいる地物の視野内の頂点が上限を超えているとき。読むだけの
//   ときは印をもともと描かないので、「上限のため」と言うと嘘になる。
// - **ただし測っている間は出さない**（統合 8A〜8D の継ぎ目の検証 2-1）。測っている間は
//   `activeTool` が null で「選ぶ」と同じに見え、印もそのまま描かれるが、左クリックは測る点に
//   なるので頂点は掴めない ―― 「印が出ない理由」を言う場面ではない。ここだけは印を描く条件と
//   **わざと食い違えている**。出すと次の一手の測るの案内（終点を押す・Esc でやめる）を上書きし、
//   数が上限を下回った瞬間の片付けで次の一手を空にして「選ぶ」の既定の文に化けさせていた。
// - 帯への押し込みは **書いた人の印**つきで行い、引っ込めるときは自分が最後に書いたときだけ
//   空へ戻す（`clearChromeIfMine`。教訓 5.68 / 5.77）。帯が持ち直されたら（道具の持ち替え）
//   押し直す（`useOptionBarEpoch`）。

import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useStore } from 'zustand';

import type { AddHostPorts } from '../add/host-ports';
import type { OptionBarAction, OptionBarStore } from '../shell/option-bar';
import { toolShowsVertexHandles } from '../shell/tools';
import { useOptionBarEpoch } from '../shell/useToolBarChrome';
import { EDIT_MODE } from '../state/session';

import { activeFeatureHandleCapStatus } from './active-feature-handles';
import {
  HANDLE_CAP_STRINGS,
  canZoomInFurther,
  featureAnchorNearCentre,
  handleCapText,
  zoomUntilHandlesShow,
} from './handle-cap';
import type { MountStore } from './mount/shared';

/** カメラの読み書き口（生きたレンダラ。描画と同じ 1 本＝教訓 5.29）。 */
type CameraPorts = Pick<AddHostPorts, 'readCamera' | 'writeCamera' | 'effectiveZoomRange'>;

export interface HandleCapNoticeProps {
  readonly store: MountStore;
  readonly optionBar: OptionBarStore;
  /** 生きたレンダラの置き場（地図が載る前は null）。 */
  readonly cameraRef: MutableRefObject<CameraPorts | null>;
}

/** ［拡大］のボタンの id（`option-bar-next-action-handle-cap-zoom`）。 */
export const HANDLE_CAP_ZOOM_ACTION_ID = 'handle-cap-zoom';

export function HandleCapNotice(props: HandleCapNoticeProps): null {
  const { store, optionBar, cameraRef } = props;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);
  const activeFeature = useStore(store, (s) => s.activeFeature);
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  const displayControl = useStore(store, (s) => s.displayControl);
  const filter = useStore(store, (s) => s.filter);
  const cap = useStore(store, (s) => s.appSettings.vertexMarkerCap);
  const selectedVertexIds = useStore(store, (s) => s.selection.vertexIds);
  const vertexOwner = useStore(store, (s) => s.selection.vertexOwner);
  // カメラは「数え直す契機」としてだけ購読する（数えるのは生きたレンダラのカメラ）。
  const camera = useStore(store, (s) => s.camera);
  const surveying = useStore(store, (s) => s.survey.active);

  // 測っている間は出さない（冒頭の注記。継ぎ目の検証 2-1）。
  const noticeApplies =
    mode !== EDIT_MODE.View && toolShowsVertexHandles(activeTool) && !surveying;

  const status = useMemo(() => {
    if (!noticeApplies || activeFeature === null) return null;
    const ports = cameraRef.current;
    if (ports === null) return null;
    const view = ports.readCamera();
    const counted = activeFeatureHandleCapStatus(
      domain,
      currentTime,
      activeFeature,
      displayControl,
      cap,
      filter,
      { selectedVertexIds, ownerFeatureId: vertexOwner },
      view,
    );
    if (counted === null) return null;
    // ズームの上限まで寄っていたら、［拡大］を出さず「拡大すると出ます」も言わない
    // （設計適合 2-4。押しても何も起きないボタンを出さない）。
    return {
      ...counted,
      atMaxZoom: !canZoomInFurther(view.camera, view.viewport, ports.effectiveZoomRange()),
    };
    // `camera` は数え直す契機（中で読むのは生きたレンダラのカメラ）。
  }, [
    noticeApplies,
    activeFeature,
    domain,
    currentTime,
    displayControl,
    cap,
    filter,
    selectedVertexIds,
    vertexOwner,
    camera,
    cameraRef,
  ]);

  // ［拡大］: 印が出るところまで、その地物の頂点を動かない点にして拡大する（handle-cap.ts）。
  // 参照を固定する（帯は押し込みの同一性でボタンの差し替えを決める）。中身は押した瞬間の
  // ストアを読む（教訓 5.6）。
  const zoomUntilShown = useCallback((): void => {
    const ports = cameraRef.current;
    if (ports === null) return;
    const s = store.getState();
    const featureId = s.activeFeature;
    if (featureId === null) return;
    const { camera: cam, viewport } = ports.readCamera();
    const selection = {
      selectedVertexIds: s.selection.vertexIds,
      ownerFeatureId: s.selection.vertexOwner,
    };
    const anchor = featureAnchorNearCentre(s.domain, s.currentTime, s.displayControl, featureId, {
      camera: cam,
      viewport,
    });
    const next = zoomUntilHandlesShow({
      camera: cam,
      viewport,
      range: ports.effectiveZoomRange(),
      anchor,
      stillCapped: (c) =>
        activeFeatureHandleCapStatus(
          s.domain,
          s.currentTime,
          featureId,
          s.displayControl,
          s.appSettings.vertexMarkerCap,
          s.filter,
          selection,
          { camera: c, viewport },
        ) !== null,
    });
    if (next !== cam) ports.writeCamera(next);
  }, [store, cameraRef]);

  const text =
    status === null ? null : handleCapText(status.counted, status.cap, status.atMaxZoom);
  const canZoom = status !== null && status.cap > 0 && !status.atMaxZoom;
  const actions = useMemo<readonly OptionBarAction[]>(
    () =>
      canZoom
        ? [{ id: HANDLE_CAP_ZOOM_ACTION_ID, label: HANDLE_CAP_STRINGS.zoom, onClick: zoomUntilShown }]
        : [],
    [canZoom, zoomUntilShown],
  );

  // 書いた人の印（この部品 1 つにつき 1 個）。
  const writerRef = useRef<object>({});
  const epoch = useOptionBarEpoch(optionBar);
  useEffect(() => {
    const writer = writerRef.current;
    if (text === null) {
      optionBar.clearChromeIfMine(writer);
      return;
    }
    optionBar.setNextStep(text, actions, writer);
  }, [optionBar, epoch, text, actions]);
  // 部品ごと外れたら引っ込める（自分が最後に書いたときだけ）。
  useEffect(
    () => () => {
      optionBar.clearChromeIfMine(writerRef.current);
    },
    [optionBar],
  );

  return null;
}

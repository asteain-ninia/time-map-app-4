// UI layer (U35 / conflict): the minimap preview canvas (FR-62 / FR-63).
//
// React owns ONLY the drawing BOUNDARY (the <canvas> mount + its CSS size); the
// actual paint is delegated to the render layer's Canvas 2D backend with the
// PURE primitive列 from `buildConflictPreview` (技術方針 2.3: 高頻度描画を React の
// 再レンダリングに載せない). The preview re-paints in an effect ONLY when its
// inputs (the conflict, the two shapes, the chosen priority, the size) change —
// not on every render (NFR 5.1 / 教訓 5.5: 依存状態変化時のみ再描画).
//
// The preview is a小領域 that changes rarely, so a one-shot imperative paint per
// dependency change is sufficient; we do NOT ride the React render path for it.

import { useEffect, useRef } from 'react';

import { Canvas2DMapRenderer } from '../../render/canvas2d-renderer';
import type { Viewport } from '../../render/camera';
import type { Conflict } from '../../domain/consistency/index';

import {
  type ConflictShapes,
  buildConflictPreview,
} from './preview';
import { PREVIEW_STRINGS } from './strings';
import type { FeatureId } from '../../domain/ids';

export interface MinimapPreviewProps {
  readonly conflict: Conflict;
  readonly shapes: ConflictShapes;
  /** The chosen priority feature id, or undefined when none chosen yet. */
  readonly priorityFeatureId: FeatureId | undefined;
  /** Preview canvas CSS size in px. */
  readonly widthPx: number;
  readonly heightPx: number;
  readonly devicePixelRatio?: number | undefined;
}

export function MinimapPreview(props: MinimapPreviewProps): JSX.Element {
  const { conflict, shapes, priorityFeatureId, widthPx, heightPx } = props;
  const dpr = props.devicePixelRatio ?? 1;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const viewport: Viewport = {
      widthCss: widthPx,
      heightCss: heightPx,
      devicePixelRatio: dpr,
    };
    const preview = buildConflictPreview(conflict, shapes, {
      viewport,
      priorityFeatureId,
    });
    // The 2D context may be unavailable in some test/headless environments; the
    // preview is参考 only, so a missing context is a no-op, never a crash. Probe
    // the context ourselves first so the renderer is only built when a real 2D
    // context exists (避ける: headless が投げる getContext のノイズ).
    let ctx: CanvasRenderingContext2D | null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      return;
    }
    if (ctx === null) return;
    const renderer = new Canvas2DMapRenderer(canvas, { camera: preview.camera, viewport });
    renderer.drawBatch({ primitives: preview.primitives });
    // Re-paint only when an input that changes the picture changes (教訓 5.5).
  }, [conflict, shapes, priorityFeatureId, widthPx, heightPx, dpr]);

  return (
    <canvas
      ref={canvasRef}
      className="conflict-preview__canvas"
      role="img"
      aria-label={PREVIEW_STRINGS.ariaLabel}
      data-testid={`conflict-preview-${conflict.id}`}
      style={{ width: widthPx, height: heightPx }}
    />
  );
}

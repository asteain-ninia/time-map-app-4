// UI layer (U20 / shell): the central map area mount boundary (技術方針 2.3).
//
// React provides ONLY a mount container + a size-notification path here. The
// imperative render layer (later unit) attaches to the container ref and reads
// sizes from the MapSizeStore; NO map-draw state is held in React, so the 60FPS
// path never rides a React re-render (技术方针 2.3, 受け入れ基準 10). A
// ResizeObserver feeds a throttled size update into the store (NFR 5.1). The
// container also hosts the map INPUT layer (教訓 5.14): pointer events land on
// the input layer and are forwarded to later interaction units; front overlays
// (modal / draggable panel / context menu) sit above it and take input first.

import { useEffect, useRef } from 'react';

import { APP_STRINGS } from './strings';
import {
  BROWSER_CLOCK,
  MapSizeStore,
  throttleTrailing,
  type MapSize,
} from './map-resize';

export interface MapContainerProps {
  /** The size store the render layer subscribes to (single truth source). */
  readonly sizeStore: MapSizeStore;
  /** Resize-notify throttle interval (ms). Default 50ms (NFR 5.1). */
  readonly throttleMs?: number;
  /**
   * Called once with the container element so a later render unit can mount its
   * Canvas. Returns an optional cleanup run on unmount.
   */
  readonly onMount?: (el: HTMLDivElement) => (() => void) | void;
  /** Pointer handler for the map input layer (later interaction unit). */
  readonly onMapPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export function MapContainer(props: MapContainerProps): JSX.Element {
  const { sizeStore, throttleMs = 50, onMount, onMapPointerDown } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

    // Throttle high-frequency resize events; the trailing call always delivers
    // the final size so the render layer never resizes to a stale dimension.
    const push = throttleTrailing<[MapSize]>(
      (size) => sizeStore.set(size),
      throttleMs,
      BROWSER_CLOCK,
    );

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      push({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(el);

    // Seed the initial size immediately (no waiting for the first resize).
    sizeStore.set({ width: el.clientWidth, height: el.clientHeight });

    const cleanup = onMount?.(el);
    return () => {
      observer.disconnect();
      if (typeof cleanup === 'function') cleanup();
    };
  }, [sizeStore, throttleMs, onMount]);

  return (
    <div className="map-area" data-testid="map-area" aria-label={APP_STRINGS.mapAriaLabel}>
      {/* The render layer mounts into this element (Canvas, later unit). */}
      <div ref={ref} className="map-area__canvas-mount" data-testid="map-canvas-mount" />
      {/* The map INPUT layer: pointer events for pan/zoom/feature ops are
          captured here and forwarded to later interaction units (教訓 5.14).
          Front overlays sit ABOVE this layer and take input first. */}
      <div
        className="map-area__input"
        data-testid="map-input-layer"
        onPointerDown={onMapPointerDown}
      />
    </div>
  );
}

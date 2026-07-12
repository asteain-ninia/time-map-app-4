// U37 — FR-15 回帰ロック: the host's PERSISTENT survey slot survives every other
// repaint path.
//
// ROOT RISK the design forbids (仕様書 §3 最重要): the renderer has ONE tool-overlay
// slot (`drawKnife` → lastOverlay) shared by knife / merge / reparent / ring / drill.
// Had the survey lines ridden that slot, the next tool draw (or its `[]` reset push)
// would silently WIPE the confirmed survey lines — breaking FR-15「解除後も線が残る」
// only in live composites, invisible to the pure compose tests. This test drives the
// REAL createAddHostPorts (stubbed 2D context — jsdom has none) and asserts via the
// onFrameComposed summary (the SAME primitives handed to drawBatch, 教訓 5.29) that:
//   - drawSurvey primitives reach the drawn frame;
//   - a tool-overlay draw (drawKnife) and its clearing `[]` push KEEP the survey slot;
//   - a full redraw() keeps it (committed/camera repaints cannot lose it);
//   - drawSurvey([]) is the ONLY host path that empties the slot (クリア経路).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeContext2D } from '../../render/fake-canvas';
import type { DrawPrimitive } from '../../render/map-renderer';

import { createAddHostPorts, type FrameSummary } from './host-ports';

function stubCanvas(): FakeContext2D {
  const ctx = new FakeContext2D();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  return ctx;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const SURVEY_BATCH: DrawPrimitive[] = [
  {
    kind: 'line',
    points: [
      { lon: 0, lat: 0 },
      { lon: 10, lat: 10 },
    ],
    widthPx: 2,
    stroke: '#1565c0',
  },
  {
    kind: 'line',
    points: [
      { lon: 0, lat: 0 },
      { lon: 10, lat: 10 },
    ],
    widthPx: 2,
    stroke: '#90a4ae',
  },
  { kind: 'point', at: { lon: 0, lat: 0 }, radiusPx: 5, fill: '#1565c0' },
  { kind: 'point', at: { lon: 10, lat: 10 }, radiusPx: 5, fill: '#1565c0' },
];

describe('createAddHostPorts — the persistent survey slot (U37 / FR-15)', () => {
  it('survey primitives persist across tool-overlay draws and redraws; only drawSurvey([]) clears', () => {
    stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    let frame: FrameSummary | null = null;
    const ports = createAddHostPorts(mount, {
      onFrameComposed: (summary) => {
        frame = summary;
      },
    });

    // 1) Push the survey batch: 2 lines + 2 endpoint markers reach the frame.
    ports.drawSurvey(SURVEY_BATCH);
    expect(frame).not.toBeNull();
    expect(frame!.line).toBe(2);
    expect(frame!.point).toBe(2);
    // The survey layer is NOT the tool overlay (FR-78 preview stays empty).
    expect(frame!.preview).toBe(0);

    // 2) A tool overlay draw (the shared drawKnife slot) does NOT wipe the survey.
    const knifeOverlay: DrawPrimitive[] = [
      { kind: 'point', at: { lon: 5, lat: 5 }, radiusPx: 4, fill: '#f00' },
    ];
    ports.drawKnife(knifeOverlay);
    expect(frame!.preview).toBe(1);
    expect(frame!.line).toBe(2); // survey lines still drawn (FR-15)
    expect(frame!.point).toBe(3); // 2 survey markers + 1 overlay point

    // 3) The tool's clearing `[]` push (every reset path) keeps the survey too.
    ports.drawKnife([]);
    expect(frame!.preview).toBe(0);
    expect(frame!.line).toBe(2);
    expect(frame!.point).toBe(2);

    // 4) A full recomposite (committed/time/camera change path) keeps the survey.
    ports.redraw();
    expect(frame!.line).toBe(2);
    expect(frame!.point).toBe(2);

    // 5) drawSurvey([]) — the クリア / LOAD / NEW push — is what empties the slot.
    ports.drawSurvey([]);
    expect(frame!.line).toBe(0);
    expect(frame!.point).toBe(0);

    ports.dispose();
    mount.remove();
  });
});

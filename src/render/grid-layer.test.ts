// U18 render grid-layer tests (FR-03 / FR-06 / FR-07 / FR-13 / FR-17, 受け入れ
// 基準 2 / 6 / 7 / 8 / 9 / 10). Pure primitive building + the base-map hit-test
// exclusion + constant-on-screen label font across zoom.

import { describe, expect, it } from 'vitest';

import {
  GRID_EMPHASIS,
  GRID_SPACINGS_DEG,
  type GridSpacingDeg,
  LAT_MAX_DEG,
  LAT_MIN_DEG,
  latitudeEmphasis,
  longitudeEmphasis,
} from '../domain/basemap/index';

import type { Camera, Viewport } from './camera';
import { Canvas2DMapRenderer } from './canvas2d-renderer';
import { FakeCanvasSurface } from './fake-canvas';
import {
  DEFAULT_GRID_STYLE,
  GRID_LABEL_HALO,
  MIN_LABEL_PITCH_PX,
  alignStepToEmphasisPeriod,
  buildBaseMapPrimitive,
  buildGridPrimitives,
  emphasisIndexPeriod,
  estimateGridLabelWidthPx,
  gridLabelHalo,
  labelStepForPitch,
  viewportLatSpan,
  viewportLonSpan,
  withOpacity,
} from './grid-layer';
import type { GridLinePrimitive, LabelPrimitive } from './map-renderer';
import { worldToScreen } from './vtransform';

const viewport: Viewport = { widthCss: 800, heightCss: 400, devicePixelRatio: 1 };
const worldCamera: Camera = { centerLon: 0, centerLat: 0, zoom: 800 / 360 };

const fakeImage = {} as unknown as CanvasImageSource;
const fullWorld = { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 };

function gridlines(prims: readonly { kind: string }[]): GridLinePrimitive[] {
  return prims.filter((p): p is GridLinePrimitive => p.kind === 'gridline');
}
function labels(prims: readonly { kind: string }[]): LabelPrimitive[] {
  return prims.filter((p): p is LabelPrimitive => p.kind === 'label');
}
/** Meridian labels sit UNDER the equator, centre-aligned (V1 判読性 layout). */
function meridianLabels(prims: readonly { kind: string }[]): LabelPrimitive[] {
  return labels(prims).filter((l) => l.align === 'center');
}
/** Parallel labels hug the LEFT edge, left-aligned (V1 判読性 layout). */
function parallelLabels(prims: readonly { kind: string }[]): LabelPrimitive[] {
  return labels(prims).filter((l) => l.align === 'left');
}
/** Meridian gridlines run pole-to-pole; parallels are horizontal at one latitude. */
function meridianLines(prims: readonly { kind: string }[]): GridLinePrimitive[] {
  return gridlines(prims).filter(
    (l) => l.points[0]!.lat === LAT_MAX_DEG && l.points[1]!.lat === LAT_MIN_DEG,
  );
}

describe('withOpacity', () => {
  it('folds opacity into an rgba string', () => {
    expect(withOpacity('#888888', 0.5)).toBe('rgba(136, 136, 136, 0.5)');
  });
  it('passes through a non-hex color', () => {
    expect(withOpacity('red', 0.5)).toBe('red');
  });
});

describe('buildBaseMapPrimitive (FR-03 / 受け入れ基準 2)', () => {
  it('places the image at the equirectangular world meta', () => {
    const p = buildBaseMapPrimitive(fakeImage, fullWorld);
    expect(p.kind).toBe('basemap');
    expect(p.lonEast - p.lonWest).toBe(360);
    expect(p.latNorth - p.latSouth).toBe(180);
  });
});

describe('buildGridPrimitives (FR-13)', () => {
  it('returns no primitives when the grid is OFF (受け入れ基準 9)', () => {
    expect(buildGridPrimitives(false, DEFAULT_GRID_STYLE, worldCamera, viewport)).toEqual([]);
  });

  it('draws parallels + meridians + labels at default 10° spacing (受け入れ基準 7)', () => {
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport);
    expect(gridlines(prims).length).toBeGreaterThan(0);
    expect(labels(prims).length).toBeGreaterThan(0);
    // The equator label "0°" is present.
    expect(labels(prims).some((l) => l.text === '0°')).toBe(true);
  });

  it('emphasizes equator / prime meridian / antimeridian distinctly (受け入れ基準 8)', () => {
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport);
    const lines = gridlines(prims);
    // An emphasized line uses the emphasis width; a normal one the normal width.
    const widths = new Set(lines.map((l) => l.widthPx));
    expect(widths.has(DEFAULT_GRID_STYLE.lineWidthPx)).toBe(true);
    expect(widths.has(DEFAULT_GRID_STYLE.emphasisLineWidthPx)).toBe(true);
    // The label color and line color of an emphasized meridian share the SAME
    // emphasis判定 (受け入れ基準 8): the prime-meridian label is the emphasis color.
    const primeLabel = labels(prims).find((l) => l.text === '0°' && l.at.lat === 0);
    expect(primeLabel?.fill).toBe(DEFAULT_GRID_STYLE.emphasisColor);
  });

  it('label font px is constant regardless of zoom (受け入れ基準 10 / FR-17)', () => {
    const zoomedIn: Camera = { ...worldCamera, zoom: worldCamera.zoom * 8 };
    const a = labels(buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport));
    const b = labels(buildGridPrimitives(true, DEFAULT_GRID_STYLE, zoomedIn, viewport));
    expect(a.every((l) => l.fontPx === DEFAULT_GRID_STYLE.labelFontPx)).toBe(true);
    expect(b.every((l) => l.fontPx === DEFAULT_GRID_STYLE.labelFontPx)).toBe(true);
  });

  it('meridian labels are U05-normalized across the seam (受け入れ基準 13)', () => {
    // Center near +180 so the visible continuous span crosses the seam.
    const seamCamera: Camera = { centerLon: 180, centerLat: 0, zoom: 800 / 90 };
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, seamCamera, viewport);
    const ls = labels(prims).filter((l) => l.at.lat === 0);
    // No meridian label winds past ±180 in TEXT (always a representative value).
    for (const l of ls) {
      const m = /^(\d+)°/.exec(l.text);
      if (m) expect(Number(m[1])).toBeLessThanOrEqual(180);
    }
    // The antimeridian appears and reads "180°".
    expect(ls.some((l) => l.text === '180°')).toBe(true);
  });
});

// --- V1 経緯度ラベルの判読性 (HIGH) -----------------------------------------
//
// At the FR-11 fit-all zoom the 10° meridian pitch is ~22 CSS px while a label like
// "170°W" measures ~35 px — so drawing EVERY meridian label produced an unreadable
// run-on blob (a structural certainty, not a chance collision). The fix thins the
// LABELS (never the lines) to a minimum on-screen pitch, and offsets/aligns them so
// they no longer sit ON the line or fall off the canvas edge.

describe('labelStepForPitch (V1 ラベル間引き)', () => {
  it('keeps every label when the on-screen pitch already clears the minimum', () => {
    expect(labelStepForPitch(MIN_LABEL_PITCH_PX)).toBe(1);
    expect(labelStepForPitch(MIN_LABEL_PITCH_PX * 4)).toBe(1);
  });
  it('thins to the smallest step whose product clears the minimum pitch', () => {
    expect(labelStepForPitch(MIN_LABEL_PITCH_PX / 2)).toBe(2);
    expect(labelStepForPitch(MIN_LABEL_PITCH_PX / 3)).toBe(3);
    // 22.2px pitch (fit-all 10° grid on an 800px viewport) ⇒ every 3rd label.
    expect(labelStepForPitch(22.2)).toBe(3);
  });
  it('a degenerate pitch falls back to the named default of 1 (教訓 5.18)', () => {
    expect(labelStepForPitch(0)).toBe(1);
    expect(labelStepForPitch(-5)).toBe(1);
    expect(labelStepForPitch(Number.NaN)).toBe(1);
  });
});

describe('buildGridPrimitives thins LABELS but never LINES (V1)', () => {
  it('draws every meridian line while dropping crowded meridian labels', () => {
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport);
    const lines = meridianLines(prims);
    const ls = meridianLabels(prims);
    expect(lines.length).toBeGreaterThan(0);
    // The lines are untouched (one per enumerated meridian) — only labels thin out.
    expect(ls.length).toBeLessThan(lines.length);
    expect(ls.length).toBeGreaterThan(0);
  });

  it('kept meridian labels clear the minimum on-screen pitch', () => {
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport);
    const xs = meridianLabels(prims)
      .map((l) => worldToScreen(l.at, worldCamera, viewport).x)
      .sort((a, b) => a - b);
    expect(xs.length).toBeGreaterThan(1);
    for (let i = 1; i < xs.length; i += 1) {
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(MIN_LABEL_PITCH_PX - 1e-6);
    }
  });

  it('kept parallel labels clear the minimum on-screen pitch', () => {
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport);
    const ys = parallelLabels(prims)
      .map((l) => worldToScreen(l.at, worldCamera, viewport).y)
      .sort((a, b) => a - b);
    expect(ys.length).toBeGreaterThan(1);
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(MIN_LABEL_PITCH_PX - 1e-6);
    }
  });

  it('emphasized lines (0° / 180° / equator) keep their label at ANY step (受け入れ基準 8)', () => {
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport);
    const mer = meridianLabels(prims);
    // Every emphasized meridian in view is labelled…
    for (const lon of [-180, 0, 180]) {
      expect(mer.some((l) => Math.abs(l.at.lon - lon) < 1e-9)).toBe(true);
    }
    // …and so is the equator, on the parallel side.
    expect(parallelLabels(prims).some((l) => latitudeEmphasis(l.at.lat) !== GRID_EMPHASIS.None)).toBe(
      true,
    );
  });

  it('labels every meridian once zoomed in enough to clear the pitch', () => {
    const zoomedIn: Camera = { ...worldCamera, zoom: worldCamera.zoom * 8 };
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, zoomedIn, viewport);
    expect(meridianLabels(prims).length).toBe(meridianLines(prims).length);
  });

  it('panning by a fractional degree does not make labels dance (integer anchoring)', () => {
    const a = buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport);
    const panned: Camera = { ...worldCamera, centerLon: worldCamera.centerLon + 3.7 };
    const b = buildGridPrimitives(true, DEFAULT_GRID_STYLE, panned, viewport);
    const keptA = new Set(meridianLabels(a).map((l) => Math.round(l.at.lon)));
    const keptB = new Set(meridianLabels(b).map((l) => Math.round(l.at.lon)));
    // Over the longitudes visible in BOTH frames the labelled set is identical:
    // the step grid is anchored to lon/spacing integers, not to the viewport edge.
    const overlap = [...keptA].filter((lon) => lon > -160 && lon < 160);
    expect(overlap.length).toBeGreaterThan(0);
    for (const lon of overlap) expect(keptB.has(lon)).toBe(true);
  });
});

describe('grid label placement is readable (V1 1-b / 1-c / 1-d / 1-e)', () => {
  const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport);

  it('parallel labels are inset from the left edge and sit ABOVE their line', () => {
    const ps = parallelLabels(prims);
    expect(ps.length).toBeGreaterThan(0);
    for (const l of ps) {
      expect(l.align).toBe('left');
      expect(l.offsetPx?.x ?? 0).toBeGreaterThan(0);
      const x = worldToScreen(l.at, worldCamera, viewport).x + (l.offsetPx?.x ?? 0);
      expect(x).toBeGreaterThan(0);
      // Comfortably-inside parallels lift the text clear of their own line; only the
      // ±90 edge cases are pushed back down by the in-canvas clamp (asserted below).
      const anchorY = worldToScreen(l.at, worldCamera, viewport).y;
      if (anchorY > 30 && anchorY < viewport.heightCss - 30) {
        expect(l.offsetPx?.y ?? 0).toBeLessThan(0);
      }
    }
  });

  it('meridian labels are centred BELOW the equator line (no line/number overlap)', () => {
    const mer = meridianLabels(prims);
    expect(mer.length).toBeGreaterThan(0);
    for (const l of mer) {
      expect(l.align).toBe('center');
      expect(l.offsetPx?.y ?? 0).toBeGreaterThan(0);
    }
  });

  it('the ±90° parallel labels are clamped INSIDE the canvas (1-c 上端はみ出し)', () => {
    for (const l of parallelLabels(prims)) {
      const y = worldToScreen(l.at, worldCamera, viewport).y + (l.offsetPx?.y ?? 0);
      // Alphabetic baseline: the glyph ascends ~fontPx above the baseline.
      expect(y).toBeGreaterThanOrEqual(DEFAULT_GRID_STYLE.labelFontPx);
      expect(y).toBeLessThanOrEqual(viewport.heightCss);
    }
  });

  it('a meridian label on the canvas edge is nudged fully inside (seam ±180 の欠け)', () => {
    const mer = meridianLabels(prims);
    for (const l of mer) {
      const cx = worldToScreen(l.at, worldCamera, viewport).x + (l.offsetPx?.x ?? 0);
      const half = estimateGridLabelWidthPx(l.text, l.fontPx) / 2;
      expect(cx - half).toBeGreaterThanOrEqual(0);
      expect(cx + half).toBeLessThanOrEqual(viewport.widthCss);
    }
    // The fit-all view spans exactly one turn, so ±180 DO land on the canvas edges and
    // must actually have been nudged (otherwise "180°" reads as a bare "0°").
    const westEdge = mer.find((l) => Math.abs(l.at.lon + 180) < 1e-9);
    const eastEdge = mer.find((l) => Math.abs(l.at.lon - 180) < 1e-9);
    expect(westEdge?.offsetPx?.x ?? 0).toBeGreaterThan(0);
    expect(eastEdge?.offsetPx?.x ?? 0).toBeLessThan(0);
    // A mid-canvas meridian is NOT nudged (the clamp only touches the edge cases).
    const mid = mer.find((l) => Math.abs(l.at.lon) < 1e-9);
    expect(mid?.offsetPx?.x ?? 0).toBe(0);
  });

  it('every grid label carries a halo so it stays legible over terrain (1-e)', () => {
    expect(labels(prims).length).toBeGreaterThan(0);
    // The halo alpha rides the SAME FR-109 gridOpacity as the text (one visual object),
    // except on emphasized labels, which are opacity-independent like their lines.
    const normalHalo = gridLabelHalo(DEFAULT_GRID_STYLE.opacity);
    for (const l of labels(prims)) {
      const expected = l.fill === DEFAULT_GRID_STYLE.emphasisColor ? GRID_LABEL_HALO : normalHalo;
      expect(l.halo).toBe(expected);
    }
  });

  it('the equator label and the 0° meridian label are vertically separated (1-d)', () => {
    const eq = parallelLabels(prims).find((l) => Math.abs(l.at.lat) < 1e-9);
    const pm = meridianLabels(prims).find((l) => Math.abs(l.at.lon) < 1e-9);
    expect(eq).toBeDefined();
    expect(pm).toBeDefined();
    const eqY = worldToScreen(eq!.at, worldCamera, viewport).y + (eq!.offsetPx?.y ?? 0);
    const pmY = worldToScreen(pm!.at, worldCamera, viewport).y + (pm!.offsetPx?.y ?? 0);
    expect(pmY - eqY).toBeGreaterThanOrEqual(DEFAULT_GRID_STYLE.labelFontPx);
  });
});

// --- fix-forward: 敵対レビュー指摘の回帰テスト ------------------------------
//
// The V1 thinning guaranteed MIN_LABEL_PITCH_PX only for the labels it KEPT on the
// `round(lon/spacing) % step` grid — the emphasized meridians (0° / ±180°) were kept
// unconditionally, so whenever `step` did not divide the emphasized lines' own index
// period they landed OFF that grid and sat 1–2 grid cells from a neighbouring label
// (a certainty at the default 10° spacing, already at zoom 1.0–1.6). The same
// divisibility hole made the surviving label SET change under a +360° pan even though
// the screen is pixel-identical. These sweeps pin both invariants over the whole
// spacing × zoom matrix instead of the single lucky camera the V1 tests used.

/** A viewport whose fit-world zoom (3.33) leaves zoom 1.0–1.6 normally reachable. */
const wideViewport: Viewport = { widthCss: 1200, heightCss: 600, devicePixelRatio: 1 };
/** Zoom levels reachable by ordinary wheel gestures on {@link wideViewport}. */
const SWEEP_ZOOMS = [1, 1.1, 1.3, 1.5, 2.2, 3.33, 5, 10] as const;

function styleWith(spacing: GridSpacingDeg): typeof DEFAULT_GRID_STYLE {
  return { ...DEFAULT_GRID_STYLE, spacing };
}

/** Kept meridian labels with their FINAL on-screen text box (anchor + offsetPx). */
function meridianLabelBoxes(
  prims: readonly { kind: string }[],
  camera: Camera,
  viewport: Viewport,
): { cx: number; half: number; text: string }[] {
  return meridianLabels(prims)
    .map((l) => ({
      cx: worldToScreen(l.at, camera, viewport).x + (l.offsetPx?.x ?? 0),
      half: estimateGridLabelWidthPx(l.text, l.fontPx) / 2,
      text: l.text,
    }))
    .sort((a, b) => a.cx - b.cx);
}

describe('emphasisIndexPeriod / alignStepToEmphasisPeriod', () => {
  it('the emphasized meridians repeat every 180°/spacing grid indices', () => {
    expect(emphasisIndexPeriod(10)).toBe(18);
    expect(emphasisIndexPeriod(15)).toBe(12);
    expect(emphasisIndexPeriod(30)).toBe(6);
    expect(emphasisIndexPeriod(0.1)).toBe(1800);
  });

  it('rounds a raw step UP to the smallest divisor of the period (never down)', () => {
    // 18 = 1·2·3·6·9·18 — a raw step of 4 or 5 is not a divisor and would leave ±180
    // off the label grid; the next divisor up is 6.
    expect(alignStepToEmphasisPeriod(4, 18)).toBe(6);
    expect(alignStepToEmphasisPeriod(5, 18)).toBe(6);
    expect(alignStepToEmphasisPeriod(3, 18)).toBe(3);
    expect(alignStepToEmphasisPeriod(1, 18)).toBe(1);
    // Never thins LESS than asked for (the pitch guarantee must not regress).
    for (const raw of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 17, 18]) {
      const s = alignStepToEmphasisPeriod(raw, 18);
      expect(s).toBeGreaterThanOrEqual(raw);
      expect(18 % s).toBe(0);
    }
  });

  it('caps at the period itself and tolerates degenerate input (教訓 5.18)', () => {
    expect(alignStepToEmphasisPeriod(19, 18)).toBe(18);
    expect(alignStepToEmphasisPeriod(1e9, 18)).toBe(18);
    expect(alignStepToEmphasisPeriod(Number.NaN, 18)).toBe(1);
    expect(alignStepToEmphasisPeriod(0, 18)).toBe(1);
  });
});

describe('kept meridian labels clear the pitch at EVERY spacing × zoom (fix-forward HIGH)', () => {
  for (const spacing of GRID_SPACINGS_DEG) {
    it(`spacing=${spacing}°: no kept label — emphasized included — sits inside the pitch`, () => {
      const violations: string[] = [];
      for (const zoom of SWEEP_ZOOMS) {
        const camera: Camera = { centerLon: 0, centerLat: 0, zoom };
        const prims = buildGridPrimitives(true, styleWith(spacing), camera, wideViewport);
        const ls = meridianLabels(prims);
        // A far-zoomed-out fine grid legitimately draws no meridians at all
        // (MAX_GRATICULE_MERIDIANS); there is nothing to space out then.
        if (ls.length < 2) continue;
        const xs = ls
          .map((l) => worldToScreen(l.at, camera, wideViewport).x)
          .sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i += 1) {
          const dx = xs[i]! - xs[i - 1]!;
          if (dx < MIN_LABEL_PITCH_PX - 1e-6) {
            violations.push(`spacing=${spacing} zoom=${zoom} dx=${dx.toFixed(2)}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

describe('a +360° pan is a no-op for the label pattern (fix-forward MEDIUM)', () => {
  for (const spacing of GRID_SPACINGS_DEG) {
    it(`spacing=${spacing}°: the same screen shows the same labels one turn later`, () => {
      const violations: string[] = [];
      for (const zoom of SWEEP_ZOOMS) {
        const at: Camera = { centerLon: 0, centerLat: 0, zoom };
        const turned: Camera = { centerLon: 360, centerLat: 0, zoom };
        const pattern = (camera: Camera): string[] =>
          meridianLabels(buildGridPrimitives(true, styleWith(spacing), camera, wideViewport))
            .map((l) => ({ x: worldToScreen(l.at, camera, wideViewport).x, text: l.text }))
            // Compare only the strict interior so a label exactly on the enumeration
            // boundary cannot flip in/out through float rounding of the span edges.
            .filter((p) => p.x > 50 && p.x < wideViewport.widthCss - 50)
            .map((p) => `${p.x.toFixed(3)}@${p.text}`)
            .sort();
        const a = pattern(at);
        const b = pattern(turned);
        if (a.join('|') !== b.join('|')) {
          violations.push(`spacing=${spacing} zoom=${zoom}: ${a.length} vs ${b.length}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

describe('the canvas-edge nudge never overruns a neighbour (fix-forward LOW)', () => {
  it('adjacent meridian label boxes never overlap after offsetPx is applied', () => {
    const violations: string[] = [];
    for (const spacing of GRID_SPACINGS_DEG) {
      for (const zoom of SWEEP_ZOOMS) {
        const camera: Camera = { centerLon: 0, centerLat: 0, zoom };
        const boxes = meridianLabelBoxes(
          buildGridPrimitives(true, styleWith(spacing), camera, wideViewport),
          camera,
          wideViewport,
        );
        for (let i = 1; i < boxes.length; i += 1) {
          const gap = boxes[i]!.cx - boxes[i]!.half - (boxes[i - 1]!.cx + boxes[i - 1]!.half);
          if (gap < -1e-6) {
            violations.push(
              `spacing=${spacing} zoom=${zoom}: ${boxes[i - 1]!.text}/${boxes[i]!.text} overlap ${(-gap).toFixed(2)}px`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('the equator row stays legible at ANY vertical pan (fix-forward LOW, 1-d 再発)', () => {
  it('meridian labels keep a full font height clear of the equator label', () => {
    const violations: string[] = [];
    const viewport400: Viewport = { widthCss: 800, heightCss: 400, devicePixelRatio: 1 };
    const fontPx = DEFAULT_GRID_STYLE.labelFontPx;
    for (let centerLat = -90; centerLat <= 90; centerLat += 1) {
      const camera: Camera = { centerLon: 0, centerLat, zoom: 800 / 360 };
      const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, camera, viewport400);
      const eq = parallelLabels(prims).find((l) => Math.abs(l.at.lat) < 1e-9);
      const pm = meridianLabels(prims).find((l) => Math.abs(l.at.lon) < 1e-9);
      if (!eq || !pm) continue;
      const eqY = worldToScreen(eq.at, camera, viewport400).y + (eq.offsetPx?.y ?? 0);
      const pmY = worldToScreen(pm.at, camera, viewport400).y + (pm.offsetPx?.y ?? 0);
      if (pmY - eqY < fontPx - 1e-6) {
        violations.push(`centerLat=${centerLat}: gap ${(pmY - eqY).toFixed(2)}px`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('both equator-row labels stay inside the canvas while separated', () => {
    const viewport400: Viewport = { widthCss: 800, heightCss: 400, devicePixelRatio: 1 };
    // Equator pushed to within 4 px of the bottom edge (anchorY ≈ 396).
    const camera: Camera = { centerLon: 0, centerLat: 196 / (800 / 360), zoom: 800 / 360 };
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, camera, viewport400);
    const eq = parallelLabels(prims).find((l) => Math.abs(l.at.lat) < 1e-9)!;
    const pm = meridianLabels(prims).find((l) => Math.abs(l.at.lon) < 1e-9)!;
    const eqY = worldToScreen(eq.at, camera, viewport400).y + (eq.offsetPx?.y ?? 0);
    const pmY = worldToScreen(pm.at, camera, viewport400).y + (pm.offsetPx?.y ?? 0);
    expect(pmY).toBeLessThanOrEqual(viewport400.heightCss);
    expect(eqY).toBeGreaterThanOrEqual(DEFAULT_GRID_STYLE.labelFontPx);
    expect(pmY - eqY).toBeGreaterThanOrEqual(DEFAULT_GRID_STYLE.labelFontPx - 1e-6);
  });
});

describe('the label halo obeys FR-109 gridOpacity (fix-forward LOW)', () => {
  it('gridOpacity=0 leaves NO white outline behind on ordinary labels', () => {
    const transparent = { ...DEFAULT_GRID_STYLE, opacity: 0 };
    const prims = buildGridPrimitives(true, transparent, worldCamera, viewport);
    const normal = labels(prims).filter((l) => l.fill !== transparent.emphasisColor);
    expect(normal.length).toBeGreaterThan(0);
    for (const l of normal) expect(l.halo).toBe(withOpacity('#ffffff', 0));
  });

  it('emphasized labels keep their halo (they ignore gridOpacity, like their lines)', () => {
    const transparent = { ...DEFAULT_GRID_STYLE, opacity: 0 };
    const prims = buildGridPrimitives(true, transparent, worldCamera, viewport);
    const emph = labels(prims).filter((l) => l.fill === transparent.emphasisColor);
    expect(emph.length).toBeGreaterThan(0);
    for (const l of emph) expect(l.halo).toBe(GRID_LABEL_HALO);
  });

  it('the halo fades proportionally so text + outline read as ONE object', () => {
    expect(gridLabelHalo(1)).toBe(GRID_LABEL_HALO);
    expect(gridLabelHalo(0.5)).toBe('rgba(255, 255, 255, 0.425)');
    expect(gridLabelHalo(0)).toBe('rgba(255, 255, 255, 0)');
  });
});

describe('viewportLatSpan', () => {
  it('full latitude band at the fit zoom', () => {
    const span = viewportLatSpan(worldCamera, viewport);
    expect(span.south).toBeCloseTo(-90, 6);
    expect(span.north).toBeCloseTo(90, 6);
  });
  it('degenerate viewport falls back to the full band', () => {
    expect(viewportLatSpan(worldCamera, { ...viewport, heightCss: 0 })).toEqual({
      south: -90,
      north: 90,
    });
  });
});

describe('viewportLonSpan', () => {
  it('full world at the fit zoom', () => {
    const span = viewportLonSpan(worldCamera, viewport);
    expect(span.west).toBeCloseTo(-180, 6);
    expect(span.east).toBeCloseTo(180, 6);
  });
  it('degenerate viewport falls back to the full world', () => {
    const span = viewportLonSpan(worldCamera, { ...viewport, widthCss: 0 });
    expect(span).toEqual({ west: -180, east: 180 });
  });
});

describe('buildGridPrimitives is hang-safe for pathological cameras (H1)', () => {
  it('a finite-but-huge centerLon (1e15) does not hang the meridian loop', () => {
    // centerLon is NOT clamped by the camera; a huge value pushes viewportLonSpan's
    // edges past 2^53 where `lon += spacing` is a float no-op. The meridian
    // enumeration must terminate (bounded count) — the assertion is completion.
    const hugeCamera: Camera = { centerLon: 1e15, centerLat: 0, zoom: 800 / 360 };
    const t0 = Date.now();
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, hugeCamera, viewport);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(Array.isArray(prims)).toBe(true);
  });

  it('an extreme zoom-out over a wide span does not allocate an unbounded array', () => {
    // Tiny zoom: viewportLonSpan covers a huge finite span → meridian count would be
    // enormous. The cap returns no meridians (parallels may still be present).
    const tinyZoom: Camera = { centerLon: 0, centerLat: 0, zoom: 1e-9 };
    const t0 = Date.now();
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, tinyZoom, viewport);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(Array.isArray(prims)).toBe(true);
  });
});

describe('base-map is NOT a hit-test target (FR-06 / 受け入れ基準 6)', () => {
  it('hitTest returns the world point under the cursor regardless of any base-map', () => {
    // The renderer's hitTest goes through the shared transform (screenToWorld) and
    // never consults drawn primitives — so a full-screen base map can never steal
    // the click. Drawing a base map and then hit-testing yields the same world
    // point as the pure transform (重なり層テスト, 教訓 5.14).
    const surface = new FakeCanvasSurface();
    const renderer = new Canvas2DMapRenderer(surface, { camera: worldCamera, viewport });
    renderer.drawBatch({ primitives: [buildBaseMapPrimitive(fakeImage, fullWorld)] });
    const center = renderer.hitTest({ x: 400, y: 200 });
    expect(center.world.lon).toBeCloseTo(0, 6);
    expect(center.world.lat).toBeCloseTo(0, 6);
    // And the base map WAS drawn (so it is a background, not absent).
    expect(surface.ctx.drawImages.length).toBeGreaterThan(0);
  });

  it('emphasis判定 is shared: the drawn antimeridian replica is still emphasized', () => {
    // A meridian enumerated at continuous +180 (the seam) is emphasized; its
    // +1-turn replica at +540 folds to the same antimeridian判定.
    expect(longitudeEmphasis(180)).toBe(GRID_EMPHASIS.Antimeridian);
    expect(longitudeEmphasis(540)).toBe(GRID_EMPHASIS.Antimeridian);
  });
});

// bughunt2 回帰: the display-area resolution is a SINGLE COMPUTATION shared by the
// draw path (committed-features) and the hit-test path (live-hit-test), not two/three
// recomputations per interaction (教訓 5.29 単一真実源 = 単一 COMPUTATION).
//
// BEFORE THE FIX: buildCommittedFeatures (draw), liveHitTestAt (every pointerdown),
// and drawnAreaAt (every knife click) EACH re-ran the whole U34 hierarchy/display
// pipeline (buildForest + resolveDisplayControl) from scratch for the SAME immutable
// (root, time, displayControl) generation — so a press paid a full re-resolution the
// just-drawn frame already computed, and a knife click paid it twice.
//
// THIS TEST spies on `resolveDisplayControl` — the expensive pipeline step every path
// funnels through — and asserts it runs EXACTLY ONCE across a draw + a press + a knife
// click at one generation (the memo HIT), then re-runs only when an input IDENTITY
// changes (displayControl / time / root), proving the cache is keyed by identity and
// never serves a stale or wrong result.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { timePointYear } from '../../domain/time/time-point';
import { FEATURE_KIND } from '../../domain/feature';
import { createVertexStore } from '../../domain/vertex';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  squareLeaf,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import type { DisplayControlInput } from '../../render/display-pipeline';
import * as displayPipeline from '../../render/display-pipeline';

import { buildCommittedFeatures } from './committed-features';
import { liveHitTestAt, drawnAreaAt } from './live-hit-test';
import {
  resolveDisplayFor,
  clearDisplayResolutionCache,
} from './display-resolution-cache';

const DISPLAY: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};

/** A single leaf existing from year 0 (one square territory at the origin). */
function project(): DomainProject {
  const leaf = squareLeaf('leaf-1', 'A国', 0, 0, 10);
  return {
    histories: [
      singleAnchorHistory('leaf-1', [leaf.feature], createVertexStore(leaf.vertices), 0),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

afterEach(() => {
  clearDisplayResolutionCache();
  vi.restoreAllMocks();
});

describe('display-resolution-cache (bughunt2: single shared computation)', () => {
  it('resolves the pipeline ONCE across draw + press + knife click at one generation', () => {
    const root = project();
    const time = timePointYear(10);
    const spy = vi.spyOn(displayPipeline, 'resolveDisplayControl');

    // 1) The renderer draws this frame (committed-features).
    buildCommittedFeatures(root, time, null, DISPLAY);
    // 2) A pointerdown hit-test on the SAME generation (root/time/displayControl).
    liveHitTestAt(
      {
        root,
        time,
        displayControl: DISPLAY,
        toScreen: (w) => ({ x: w.lon, y: w.lat }),
        point: { x: 5, y: 5 },
      },
      { lon: 5, lat: 5 },
    );
    // 3) A knife featureAtPoint click on the SAME generation.
    drawnAreaAt({ root, time, displayControl: DISPLAY }, { lon: 5, lat: 5 });

    // All three reused ONE resolution — the pipeline ran a single time, not three.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-resolves when the displayControl IDENTITY changes (no stale result)', () => {
    const root = project();
    const time = timePointYear(10);
    const spy = vi.spyOn(displayPipeline, 'resolveDisplayControl');

    resolveDisplayFor(root, time, DISPLAY);
    expect(spy).toHaveBeenCalledTimes(1);

    // Same VALUE, different OBJECT identity → a miss → a fresh (identical) resolution.
    const otherControl: DisplayControlInput = {
      globalDepth: 0,
      focus: { originId: null, depth: 0, emphasize: false },
    };
    resolveDisplayFor(root, time, otherControl);
    expect(spy).toHaveBeenCalledTimes(2);

    // Re-querying the FIRST identity is a hit again (still cached, LRU capacity ≥ 2).
    resolveDisplayFor(root, time, DISPLAY);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('re-resolves when the time IDENTITY changes', () => {
    const root = project();
    const spy = vi.spyOn(displayPipeline, 'resolveDisplayControl');

    resolveDisplayFor(root, timePointYear(10), DISPLAY);
    resolveDisplayFor(root, timePointYear(20), DISPLAY);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('returns the SAME bundle object on a cache hit (identity reuse, not a copy)', () => {
    const root = project();
    const time = timePointYear(10);

    const first = resolveDisplayFor(root, time, DISPLAY);
    const second = resolveDisplayFor(root, time, DISPLAY);

    expect(second).toBe(first);
    expect(second.resolved).toBe(first.resolved);
    expect(second.features).toBe(first.features);
    expect(second.vertices).toBe(first.vertices);
    // bughunt3: the filtered area-feature list is reused, not re-derived per consumer.
    expect(second.areaFeatures).toBe(first.areaFeatures);
  });

  // bughunt3 回帰: the resolution EXPOSES the leaf/aggregate `areaFeatures` it already
  // filtered to build the forest, so the draw path (committed-features `buildAreas`) can
  // reuse it instead of re-running the IDENTICAL O(n) leaf/aggregate scan over `features`
  // a second time per cache miss (every real state change). Before the fix the bundle had
  // no `areaFeatures` field and committed-features re-filtered `features` itself.
  it('exposes the filtered AREA features (leaf + aggregate), reused not re-derived', () => {
    const root = project();
    const time = timePointYear(10);

    const resolution = resolveDisplayFor(root, time, DISPLAY);

    // The square leaf is an area feature; it is present, points/lines would be excluded.
    expect(resolution.areaFeatures.map((f) => f.id)).toEqual(['leaf-1']);
    // It is EXACTLY the same-kind filter the cache applies to build the forest — every
    // exposed feature is a leaf or aggregate, never a point/line.
    for (const f of resolution.areaFeatures) {
      expect([FEATURE_KIND.Leaf, FEATURE_KIND.Aggregate]).toContain(f.kind);
    }
    // The forest is built from exactly these area features (same single source).
    expect(resolution.forest.byId.size).toBe(resolution.areaFeatures.length);
  });
});

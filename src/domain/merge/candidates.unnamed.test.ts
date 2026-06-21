// Regression (bughunt): the結合対象 / 引き継ぎ元 pickers must not show a blank,
// sight-unselectable label for an UNNAMED face (the add form's default — empty
// name). Both candidate builders share the domain's single display-name fallback
// (featureDisplayName: name → id), so an unnamed face shows its id, never ''.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes } from '../attributes';
import { createLeafFeature, type Feature } from '../feature';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';

import { COLOR } from './fixtures';
import {
  allowedMergeParentCandidates,
  propertyInheritCandidates,
} from './candidates';

/** A leaf with an explicit (possibly blank) name. */
function namedLeaf(id: string, name: string): Feature {
  const shape = createShape([
    createTerritoryRing(asRingId(`r-${id}`), [
      asVertexId(`${id}-v1`),
      asVertexId(`${id}-v2`),
      asVertexId(`${id}-v3`),
    ]),
  ]);
  return createLeafFeature(asFeatureId(id), createBasicAttributes(name, 0, 100), COLOR, shape);
}

describe('merge candidate builders: unnamed-face display label', () => {
  it('allowedMergeParentCandidates gives an unnamed parent a non-blank label', () => {
    // Target T is merged; P is an unnamed candidate parent (empty name).
    const target = namedLeaf('T', 'target');
    const parent = namedLeaf('P', '   '); // present-but-blank
    const cands = allowedMergeParentCandidates([target, parent], [asFeatureId('T')], 50);
    const p = cands.find((c) => c.featureId === asFeatureId('P'));
    expect(p).toBeDefined();
    expect(p?.displayName.trim().length).toBeGreaterThan(0);
    expect(p?.displayName).toBe('P');
  });

  it('propertyInheritCandidates gives an unnamed target a non-blank label', () => {
    const unnamed = namedLeaf('U', '');
    const cands = propertyInheritCandidates([unnamed], [asFeatureId('U')]);
    expect(cands).toHaveLength(1);
    expect(cands[0]?.displayName.trim().length).toBeGreaterThan(0);
    expect(cands[0]?.displayName).toBe('U');
  });
});

// U32 詳細文書 edit plan tests (FR-98): the single WRITE guard + no-op + canonical
// empty rule the sidebar save button and the live dispatch both consult.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  MAX_DETAIL_DOCUMENT_LENGTH,
  createPointFeature,
  withDetailDocument,
} from '../../domain/index';
import { asFeatureId, asVertexId } from '../../domain/ids';

import { DETAIL_DOCUMENT_PLAN, planDetailDocumentEdit } from './detail-document';

const color = createColorInfo(true, '#111111', '#222222', '#333333');

function feat(doc?: string) {
  const base = createPointFeature(
    asFeatureId('F'),
    createBasicAttributes('城', 1, 2),
    color,
    asVertexId('F-v'),
  );
  return doc === undefined ? base : withDetailDocument(base, doc);
}

describe('planDetailDocumentEdit — FR-98 の単一保存判定', () => {
  it('a changed draft plans an Edit whose feature carries the new document', () => {
    const plan = planDetailDocumentEdit(feat('旧文書'), '**新**文書');
    expect(plan.kind).toBe(DETAIL_DOCUMENT_PLAN.Edit);
    if (plan.kind !== DETAIL_DOCUMENT_PLAN.Edit) return;
    expect(plan.feature.detailDocument).toBe('**新**文書');
    // Every other field is preserved (the with系 discipline).
    expect(plan.feature.id).toBe(asFeatureId('F'));
    expect(plan.feature.attributes.name).toBe('城');
  });

  it('an unchanged draft is a NoOp (no ghost undo, 教訓 5.24)', () => {
    expect(planDetailDocumentEdit(feat('同じ'), '同じ').kind).toBe(DETAIL_DOCUMENT_PLAN.NoOp);
  });

  it("'' on an absent document is a NoOp (one canonical empty form)", () => {
    expect(planDetailDocumentEdit(feat(), '').kind).toBe(DETAIL_DOCUMENT_PLAN.NoOp);
  });

  it("'' on an existing document plans an Edit that clears it to ABSENT (空→absent)", () => {
    const plan = planDetailDocumentEdit(feat('消える文書'), '');
    expect(plan.kind).toBe(DETAIL_DOCUMENT_PLAN.Edit);
    if (plan.kind !== DETAIL_DOCUMENT_PLAN.Edit) return;
    expect('detailDocument' in plan.feature).toBe(false);
  });

  it('a draft over MAX_DETAIL_DOCUMENT_LENGTH is TooLong and NEVER throws (WRITE guard)', () => {
    const overMax = 'x'.repeat(MAX_DETAIL_DOCUMENT_LENGTH + 1);
    const plan = planDetailDocumentEdit(feat('旧'), overMax);
    expect(plan.kind).toBe(DETAIL_DOCUMENT_PLAN.TooLong);
    if (plan.kind !== DETAIL_DOCUMENT_PLAN.TooLong) return;
    expect(plan.length).toBe(MAX_DETAIL_DOCUMENT_LENGTH + 1);
    expect(plan.max).toBe(MAX_DETAIL_DOCUMENT_LENGTH);
  });

  it('a draft of exactly MAX_DETAIL_DOCUMENT_LENGTH is accepted (boundary, 教訓 5.18)', () => {
    const atMax = 'あ'.repeat(MAX_DETAIL_DOCUMENT_LENGTH);
    const plan = planDetailDocumentEdit(feat(), atMax);
    expect(plan.kind).toBe(DETAIL_DOCUMENT_PLAN.Edit);
    if (plan.kind !== DETAIL_DOCUMENT_PLAN.Edit) return;
    expect(plan.feature.detailDocument).toBe(atMax);
  });
});

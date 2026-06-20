// U26 — the継承先選択モーダル (FR-93, 教訓 5.4 / 5.14).
//
// Shown after the split is validated (phase ChoosingInheritor). It is a CENTERED
// modal that:
//   - previews BOTH split results with the小さい方 (面積比較) boxed (FR-93 小さい方
//     プレビュー). The smaller side is computed in the domain (`smallerSide`) and
//     passed in as `smallerSide` so the UI and geometry agree (教訓 5.30).
//   - offers a継承先 button per side with selection HIGHLIGHT (FR-93 ボタン選択時
//     ハイライト) — seeded to the小さい方 by the domain (教訓 5.4 UI 文脈優先).
//   - confirms via the確定 button (the完了トリガー the controller wires; 教訓 5.7).
//
// INPUT-LAYER DESIGN (教訓 5.14): a full-surface BACKDROP UNDER the dialog captures
// pointer events so背面 (map / cut-line input) cannot be operated while the modal
// is open; the dialog sits ABOVE it and its buttons receive input directly. Esc
// cancels. This is the same layering the conflict modal uses.

import { useCallback, useEffect, useRef } from 'react';

import { INHERITANCE_SIDE, type InheritanceSide } from '../../domain/knife/index';
import type { GeoMultiPolygon } from '../../domain/geometry/types';

import { KNIFE_STRINGS } from './strings';

export interface InheritorModalProps {
  /** Side A geometry (for the preview). */
  readonly sideA: GeoMultiPolygon;
  /** Side B geometry (for the preview). */
  readonly sideB: GeoMultiPolygon;
  /** Which side is the small方 (domain-computed; FR-93). It is boxed in the preview. */
  readonly smallerSide: InheritanceSide;
  /** The currently-highlighted choice (seeded to the小さい方; FR-93). */
  readonly selected: InheritanceSide;
  /** Highlight a継承先 choice (FR-93). */
  readonly onSelect: (side: InheritanceSide) => void;
  /** Confirm the highlighted継承先 (教訓 5.7 完了トリガー). */
  readonly onConfirm: () => void;
  /** Cancel the whole knife operation (教訓 5.2). */
  readonly onCancel: () => void;
}

/** Bounding box across both sides (for a shared preview viewBox). */
function boundsOf(...mps: readonly GeoMultiPolygon[]): {
  minX: number;
  minY: number;
  w: number;
  h: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const mp of mps) {
    for (const poly of mp) {
      for (const ring of poly) {
        for (const c of ring) {
          if (c.lon < minX) minX = c.lon;
          if (c.lon > maxX) maxX = c.lon;
          if (c.lat < minY) minY = c.lat;
          if (c.lat > maxY) maxY = c.lat;
        }
      }
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, w: 1, h: 1 };
  return { minX, minY, w: Math.max(maxX - minX, 1e-6), h: Math.max(maxY - minY, 1e-6) };
}

/** Outer-ring path data (preview only; holes omitted for the thumbnail). */
function pathFor(mp: GeoMultiPolygon): string {
  const parts: string[] = [];
  for (const poly of mp) {
    const outer = poly[0];
    if (outer === undefined || outer.length === 0) continue;
    const d = outer
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.lon} ${c.lat}`)
      .join(' ');
    parts.push(`${d} Z`);
  }
  return parts.join(' ');
}

const PREVIEW_PX = 200;

export function InheritorModal(props: InheritorModalProps): JSX.Element {
  const { sideA, sideB, smallerSide, selected, onSelect, onConfirm, onCancel } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [onCancel],
  );

  // Focus the dialog on mount so Esc / Tab are captured (教訓 5.14).
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const b = boundsOf(sideA, sideB);
  // SVG y grows downward; flip lat so north is up in the preview.
  const viewBox = `${b.minX} ${-(b.minY + b.h)} ${b.w} ${b.h}`;
  const smallerMp = smallerSide === INHERITANCE_SIDE.A ? sideA : sideB;
  const sb = boundsOf(smallerMp);

  return (
    <div className="knife-modal-root" data-testid="knife-inheritor-modal-root">
      {/* Backdrop captures input so背面 cannot be operated (教訓 5.14). */}
      <div
        className="knife-backdrop"
        data-testid="knife-backdrop"
        aria-hidden="true"
        onPointerDownCapture={(e) => e.stopPropagation()}
        onClickCapture={(e) => e.stopPropagation()}
      />
      <div
        className="knife-dialog"
        data-testid="knife-inheritor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={KNIFE_STRINGS.inheritorTitle}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="knife-dialog__header">
          <h2 className="knife-dialog__title">{KNIFE_STRINGS.inheritorTitle}</h2>
        </header>

        <p className="knife-dialog__hint" data-testid="knife-smaller-hint">
          {KNIFE_STRINGS.smallerHint}
        </p>

        {/* The shared preview: both sides drawn; the小さい方 boxed (FR-93). */}
        <svg
          className="knife-preview"
          data-testid="knife-preview"
          width={PREVIEW_PX}
          height={PREVIEW_PX}
          viewBox={viewBox}
          // Flip y so latitude points up (the data is lat-up, SVG is y-down).
          style={{ transform: 'scaleY(-1)' }}
        >
          <path
            data-testid="knife-preview-a"
            d={pathFor(sideA)}
            className={
              'knife-preview__side' +
              (selected === INHERITANCE_SIDE.A ? ' knife-preview__side--selected' : '')
            }
            fill={selected === INHERITANCE_SIDE.A ? 'rgba(255,193,7,0.5)' : 'rgba(120,144,156,0.4)'}
            stroke="#37474f"
            strokeWidth={b.w / PREVIEW_PX}
          />
          <path
            data-testid="knife-preview-b"
            d={pathFor(sideB)}
            className={
              'knife-preview__side' +
              (selected === INHERITANCE_SIDE.B ? ' knife-preview__side--selected' : '')
            }
            fill={selected === INHERITANCE_SIDE.B ? 'rgba(255,193,7,0.5)' : 'rgba(120,144,156,0.4)'}
            stroke="#37474f"
            strokeWidth={b.w / PREVIEW_PX}
          />
          {/* 小さい方を囲うプレビューボックス (FR-93). */}
          <rect
            data-testid="knife-smaller-box"
            x={sb.minX}
            y={-(sb.minY + sb.h)}
            width={sb.w}
            height={sb.h}
            fill="none"
            stroke="#d50000"
            strokeWidth={(b.w / PREVIEW_PX) * 2}
            strokeDasharray={`${b.w / 30} ${b.w / 60}`}
          />
        </svg>

        <div className="knife-dialog__choices" role="group" aria-label={KNIFE_STRINGS.inheritorTitle}>
          <button
            type="button"
            data-testid="knife-choose-a"
            aria-pressed={selected === INHERITANCE_SIDE.A}
            className={
              'knife-choice' +
              (selected === INHERITANCE_SIDE.A ? ' knife-choice--selected' : '')
            }
            onClick={() => onSelect(INHERITANCE_SIDE.A)}
          >
            {KNIFE_STRINGS.chooseSideA}
          </button>
          <button
            type="button"
            data-testid="knife-choose-b"
            aria-pressed={selected === INHERITANCE_SIDE.B}
            className={
              'knife-choice' +
              (selected === INHERITANCE_SIDE.B ? ' knife-choice--selected' : '')
            }
            onClick={() => onSelect(INHERITANCE_SIDE.B)}
          >
            {KNIFE_STRINGS.chooseSideB}
          </button>
        </div>

        <footer className="knife-dialog__footer">
          <button
            type="button"
            className="knife-dialog__cancel"
            data-testid="knife-modal-cancel"
            onClick={() => onCancel()}
          >
            {KNIFE_STRINGS.cancel}
          </button>
          <button
            type="button"
            className="knife-dialog__confirm"
            data-testid="knife-confirm-inheritor"
            onClick={() => onConfirm()}
          >
            {KNIFE_STRINGS.confirmInheritor}
          </button>
        </footer>
      </div>
    </div>
  );
}

// A recording fake `CanvasRenderingContext2D` + `CanvasSurface` for U17 tests.
//
// The render tests run in plain Node (no jsdom): the Canvas 2D backend's
// CORRECTNESS we care about — that positions come from the shared transform and
// that sizes (radiusPx / lineWidth / fontPx) are set in SCREEN space independent
// of zoom (FR-17) — is observable by recording the draw calls. We therefore stub
// only the handful of context methods the renderer uses, recording the arguments,
// and cast to the real type at the surface boundary (the renderer never reads
// back any unstubbed member).

import type { CanvasSurface } from './canvas2d-renderer';

export interface RecordedArc {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** Captures the draw calls the Canvas2D renderer issues. */
export class FakeContext2D {
  arcs: RecordedArc[] = [];
  lineWidths: number[] = [];
  fonts: string[] = [];
  fillTexts: { text: string; x: number; y: number }[] = [];
  moveTos: { x: number; y: number }[] = [];
  lineTos: { x: number; y: number }[] = [];
  /** Each fill call records (fillStyle, fill-rule) so even-odd hole透過 is testable. */
  fills: { style: string; rule: string }[] = [];
  /** Each stroke call records its strokeStyle (paired with lineWidths by index). */
  strokes: string[] = [];
  closePaths = 0;
  drawImages: { x: number; y: number; w: number; h: number }[] = [];
  clearRects = 0;
  setTransforms: number[][] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  font = '';

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.setTransforms.push([a, b, c, d, e, f]);
  }
  clearRect(): void {
    this.clearRects += 1;
  }
  beginPath(): void {}
  closePath(): void {
    this.closePaths += 1;
  }
  moveTo(x: number, y: number): void {
    this.moveTos.push({ x, y });
  }
  lineTo(x: number, y: number): void {
    this.lineTos.push({ x, y });
  }
  arc(x: number, y: number, r: number): void {
    this.arcs.push({ x, y, r });
  }
  fill(rule?: string): void {
    this.fills.push({ style: this.fillStyle, rule: rule ?? 'nonzero' });
  }
  stroke(): void {
    this.lineWidths.push(this.lineWidth);
    this.strokes.push(this.strokeStyle);
  }
  fillText(text: string, x: number, y: number): void {
    this.fonts.push(this.font);
    this.fillTexts.push({ text, x, y });
  }
  drawImage(_img: unknown, x: number, y: number, w: number, h: number): void {
    this.drawImages.push({ x, y, w, h });
  }
}

/** A `CanvasSurface` backed by a `FakeContext2D`, recording backing-buffer size. */
export class FakeCanvasSurface implements CanvasSurface {
  width = 0;
  height = 0;
  readonly ctx = new FakeContext2D();

  getContext(): CanvasRenderingContext2D | null {
    return this.ctx as unknown as CanvasRenderingContext2D;
  }
}

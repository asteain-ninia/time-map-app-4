// Domain layer: framework-free, pure TypeScript.
// No imports from render / ui / shell are permitted (enforced by ESLint).
//
// This placeholder exists only to (a) give the layer a real file and
// (b) provide a trivially testable pure function so Vitest can run the
// domain in plain Node, without Electron or React. Real domain models
// (features, anchors, trees, vertices) arrive in later units.

export function add(a: number, b: number): number {
  return a + b;
}

// UI layer (U20 / shell): z-order management for floating panels (FR-112).
//
// Multiple draggable panels can be open at once; clicking one brings it to the
// front (前面化). This is a pure model over a panel-id ordering so the stacking
// logic is unit-tested without the DOM (受け入れ基準 5). Components map the
// resulting order index to a CSS z-index.

/** A stable ordering of panel ids from back (index 0) to front (last). */
export class ZOrder {
  private order: string[] = [];

  /** Register a panel at the front (top) if not already present. */
  add(id: string): void {
    if (!this.order.includes(id)) this.order.push(id);
  }

  /** Remove a panel from the stack (on close). */
  remove(id: string): void {
    this.order = this.order.filter((x) => x !== id);
  }

  /** Bring a panel to the front; no-op if absent. Idempotent if already front. */
  bringToFront(id: string): void {
    if (!this.order.includes(id)) return;
    this.order = this.order.filter((x) => x !== id);
    this.order.push(id);
  }

  /** The z-index for a panel (back = 0, front = highest). -1 if not present. */
  indexOf(id: string): number {
    return this.order.indexOf(id);
  }

  /** The front-most panel id, or undefined when empty. */
  top(): string | undefined {
    return this.order[this.order.length - 1];
  }

  /** Snapshot of the back-to-front order. */
  toArray(): readonly string[] {
    return [...this.order];
  }
}

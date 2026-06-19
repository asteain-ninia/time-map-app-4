// Command result contract (教訓 5.11: structure-changing operations report
// "survived / created / deleted" element IDs so the UI re-resolves selection
// from the result instead of a blanket clear).
//
// This type is a layer-crossing contract (開発ガイド §4「層をまたぐ契約の固定」):
// the command layer (domain) produces it, and the selection/UI layer consumes
// it. It is fixed here as a shared type and exercised by both-side tests so the
// two layers do not rely on accidental structural agreement (教訓 5.33 / 5.34).
//
// `domain` stays pure: the result also carries the set of element IDs the
// operation *touched*, which is the value form of the symmetric execute / undo
// / redo notification (教訓 5.23). The domain never fires events itself; outer
// layers read `touched` and notify (技術方針 2.6 / 5.4).

import type { DomainId } from '../ids';

/**
 * Identifies which element IDs a command affected. All four sets use the
 * branded `DomainId` union (教訓 5.19: identity values flow through the type
 * system, never bare strings).
 *
 * Invariants (checked in tests):
 *   - `created`, `survived`, `deleted` are pairwise disjoint.
 *   - `touched` is the union that notification fires on; for a single command
 *     it equals `created ∪ survived ∪ deleted`. Outer layers fire on `touched`
 *     symmetrically for execute / undo / redo, with no double-notification.
 */
export interface CommandResult {
  /** Elements that existed before and still exist after (possibly changed). */
  readonly survived: ReadonlySet<DomainId>;
  /** Elements newly minted by this command (their first-generation IDs). */
  readonly created: ReadonlySet<DomainId>;
  /** Elements removed by this command. */
  readonly deleted: ReadonlySet<DomainId>;
  /**
   * Every element the operation touched — the exact notification set. Fired on
   * symmetrically by execute / undo / redo (教訓 5.23).
   */
  readonly touched: ReadonlySet<DomainId>;
}

interface CommandResultInput {
  readonly survived?: Iterable<DomainId>;
  readonly created?: Iterable<DomainId>;
  readonly deleted?: Iterable<DomainId>;
  /**
   * Optional explicit touched set. When omitted it defaults to
   * `created ∪ survived ∪ deleted`, which is correct for a single command.
   * Composite results compute `touched` by aggregation (see {@link mergeCommandResults}).
   */
  readonly touched?: Iterable<DomainId>;
}

function toSet(ids: Iterable<DomainId> | undefined): Set<DomainId> {
  return new Set(ids ?? []);
}

function union<T>(...sets: ReadonlyArray<ReadonlySet<T>>): Set<T> {
  const out = new Set<T>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

/**
 * Build a command result. Factory rather than literal so every command mints
 * results the same way (教訓 5.19) and a command cannot accidentally omit a
 * required field. When `touched` is not given it defaults to the union of the
 * three change sets.
 */
export function createCommandResult(input: CommandResultInput): CommandResult {
  const survived = toSet(input.survived);
  const created = toSet(input.created);
  const deleted = toSet(input.deleted);
  const touched =
    input.touched === undefined
      ? union(survived, created, deleted)
      : toSet(input.touched);
  return { survived, created, deleted, touched };
}

/** The empty result — no element was created, survived, deleted, or touched. */
export const EMPTY_COMMAND_RESULT: CommandResult = createCommandResult({});

/**
 * Aggregate the results of a composite operation's sub-operations into a single
 * result (受け入れ基準 4 / 教訓 5.11). Aggregation rules:
 *
 *   - An ID created by an earlier sub-op and deleted by a later one is
 *     transient: it counts as neither `created` nor `deleted` nor `survived`
 *     in the aggregate (it never existed before the composite and does not
 *     exist after it).
 *   - An ID deleted by an earlier sub-op and re-created by a later one is, on
 *     balance, `created` (it did not exist before the composite, exists after).
 *   - An ID created earlier and surviving later stays `created`.
 *   - An ID that survives any sub-op and is not finally deleted is `survived`,
 *     unless it was created within the composite (then it is `created`).
 *   - `touched` is the union of every sub-op's touched set (everything the
 *     composite notified on), so execute / undo / redo notify symmetrically
 *     over the whole composite (教訓 5.23).
 *
 * The aggregate's `created` / `survived` / `deleted` remain pairwise disjoint.
 */
export function mergeCommandResults(
  results: ReadonlyArray<CommandResult>,
): CommandResult {
  // Track the net lifecycle of each ID across the ordered sub-ops.
  // 'created'  : minted within the composite and not (yet) deleted
  // 'survived' : pre-existing and not deleted
  // 'deleted'  : pre-existing and deleted within the composite
  // 'transient': created within the composite and then deleted (drops out)
  type Net = 'created' | 'survived' | 'deleted' | 'transient';
  const net = new Map<DomainId, Net>();
  const touched = new Set<DomainId>();

  for (const r of results) {
    for (const id of r.touched) touched.add(id);

    for (const id of r.created) {
      // Whether previously deleted, survived, or unseen, a (re-)creation makes
      // the net state 'created': it does not exist before the composite and
      // does exist after it.
      net.set(id, 'created');
    }
    for (const id of r.survived) {
      const prev = net.get(id);
      // Surviving keeps a created ID as created; otherwise it is survived.
      if (prev === 'created') net.set(id, 'created');
      else net.set(id, 'survived');
    }
    for (const id of r.deleted) {
      const prev = net.get(id);
      // Deleting an ID minted within the composite makes it transient (drops).
      if (prev === 'created') net.set(id, 'transient');
      else net.set(id, 'deleted');
    }
  }

  const survived = new Set<DomainId>();
  const created = new Set<DomainId>();
  const deleted = new Set<DomainId>();
  for (const [id, state] of net) {
    switch (state) {
      case 'created':
        created.add(id);
        break;
      case 'survived':
        survived.add(id);
        break;
      case 'deleted':
        deleted.add(id);
        break;
      case 'transient':
        break;
    }
  }

  return { survived, created, deleted, touched };
}

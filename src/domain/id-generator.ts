// Pure ID generation service (lesson 5.37: do not depend on a millisecond
// timestamp alone — it collides within the same millisecond).
//
// Design constraints from the spec / tech policy:
//   - Same-millisecond generation must not collide -> a monotonic counter is
//     combined with the time source value.
//   - Generation must check against an existing ID set so a freshly minted ID
//     never collides with one already in use (lesson 5.37).
//   - Pure / no hidden global mutable state: the caller passes the current
//     generator state in and receives the next state out, so generation is
//     deterministic and testable (NFR 5.8). The time source is injected, not
//     read from `Date.now()` directly (lesson 5.15).
//   - redo can replay a recorded ID instead of re-minting one, because the
//     generated ID is returned as data rather than hidden inside a closure
//     (lesson 5.20).

/**
 * Immutable generator state. `counter` is a monotonic sequence that
 * disambiguates IDs minted at the same time-source value. `time` is the last
 * observed time-source reading; it is advanced to `max(time, source())` on
 * each step so a non-monotonic clock can never make IDs go backwards.
 */
export interface IdGeneratorState {
  readonly counter: number;
  readonly time: number;
}

/** A monotonic-ish source of integer "time" (e.g. ms since epoch). Injected. */
export type TimeSource = () => number;

export interface GeneratedId {
  readonly value: string;
  readonly state: IdGeneratorState;
}

/**
 * The minimal membership-test contract the generator needs for its duplicate
 * check (lesson 5.37). It only ever asks "is this candidate already taken?", so
 * it requires nothing beyond `has`. A `ReadonlySet<string>` satisfies this
 * structurally; callers that union several id sources can also pass a cheap
 * composite view (e.g. live-project-scan ∪ session-issued) WITHOUT copying the
 * whole set per call.
 */
export interface IdReservation {
  has(id: string): boolean;
}

export function createIdGeneratorState(
  initialTime = 0,
  initialCounter = 0,
): IdGeneratorState {
  return { counter: initialCounter, time: initialTime };
}

function formatId(prefix: string, time: number, counter: number): string {
  // Base36 keeps IDs compact while remaining a valid plain-string token.
  return `${prefix}-${time.toString(36)}-${counter.toString(36)}`;
}

/**
 * Generate the next raw ID string. Pure: derives the new ID purely from the
 * passed state + time source, returns the ID together with the advanced state.
 *
 * @param prefix  short discriminator for the ID kind (e.g. 'v', 'f', 'r').
 * @param state   current generator state.
 * @param now     injected time source.
 * @param existing optional membership test over raw IDs already in use; the
 *                 generator skips any candidate present here (duplicate check,
 *                 lesson 5.37). Any `ReadonlySet<string>` satisfies it.
 */
export function nextRawId(
  prefix: string,
  state: IdGeneratorState,
  now: TimeSource,
  existing?: IdReservation,
): GeneratedId {
  const observed = now();
  // Never let the time component move backwards even if `now` is non-monotonic.
  const time = observed > state.time ? observed : state.time;
  let counter = state.counter;

  // Advance the counter until we produce a candidate not already in use.
  // Because the counter strictly increases, this terminates.
  let candidate = formatId(prefix, time, counter);
  while (existing?.has(candidate) === true) {
    counter += 1;
    candidate = formatId(prefix, time, counter);
  }

  return {
    value: candidate,
    state: { counter: counter + 1, time },
  };
}

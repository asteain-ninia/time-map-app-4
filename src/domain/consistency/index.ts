// U13 — consistency-maintenance orchestration: public barrel.
//
// Fixed-order pipeline (FR-61) that ties together U09 (time) / U10 (spatial) /
// U06 (boolean difference) / U12 (single undo unit) through injected ports, as a
// pure domain調停役. Value types make invalid process states unrepresentable,
// rejections carry both a machine code and a Japanese message (FR-115), and the
// whole confirmation is one indivisible undo unit (FR-73 / FR-94).

export {
  // value types
  CONFLICT_KIND,
  type ConflictKind,
  type ConflictTime,
  type ConflictParticipant,
  type Conflict,
  type EditProposal,
  createEditProposal,
  type Resolution,
  // process result discriminated union
  PROCESS_STATUS,
  type ProcessStatus,
  REJECTION_KIND,
  type RejectionKind,
  type TimeRejectionReason,
  type CommittedResult,
  type ConflictsPendingResult,
  type RejectedResult,
  type ProcessResult,
  // ports
  type TimeCheckResult,
  type SpatialCheckResult,
  type ConsistencyPorts,
} from './types';

export {
  DEFAULT_MAX_CONVERGENCE_ROUNDS,
  type ProcessOptions,
  startProcess,
  applyResolutions,
} from './orchestrator';

export {
  type DisplayNameLookup,
  type ConflictTimeLookup,
  conflictIdFor,
  conflictFromOverlapPair,
  conflictsFromOverlapPairs,
} from './conflict-adapter';

export {
  MSG_TIME_VALIDATION_FAILED,
  MSG_CONSTRAINT_VIOLATION,
  MSG_CONVERGENCE_FAILED,
  MSG_INTERNAL_ERROR,
  timeRejectionMessage,
} from './messages';

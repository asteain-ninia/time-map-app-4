// U15 — shell I/O public barrel. The `.gimoza` ZIP read/write adapters, atomic
// write, generation backup, auto-save scheduler, the load (Zod-boundary) adapter
// and the save pipeline — exported together so the persistence-IO surface moves
// as one change unit (教訓5.31).

export {
  MANIFEST_ENTRY,
  BASEMAP_ENTRY,
  ATTACHMENTS_DIR,
  attachmentEntry,
  attachmentNameOf,
} from './entry-paths';

export {
  buildTmap,
  readTmap,
  type TmapContents,
  type ExtractedTmap,
  type ReadTmapResult,
} from './tmap';

export {
  nodeFsOps,
  tempPathFor,
  atomicWrite,
  type FsOps,
  type AtomicWriteResult,
} from './atomic';

export {
  DEFAULT_MAX_GENERATIONS,
  backupName,
  backupKeyOf,
  compareBackupNames,
  selectBackupsToDelete,
  nextSequence,
  runBackup,
  type BackupFsOps,
  type BackupResult,
} from './backup';

export {
  DEFAULT_AUTO_SAVE_INTERVAL_MS,
  realTimerPort,
  createAutoSaveScheduler,
  type TimerPort,
  type AutoSaveScheduler,
} from './autosave';

export { loadTmapBytes } from './load';

export { saveTmap, type SaveEnv, type SaveTmapResult } from './save';

export {
  DIAGNOSTIC_LOG_PREFIX,
  DIAGNOSTIC_LOG_EXT,
  DEFAULT_DIAGNOSTIC_LOG_GENERATIONS,
  MAX_LOG_LEVEL_CHARS,
  MAX_LOG_MESSAGE_CHARS,
  MAX_LOG_CONTEXT_VALUE_CHARS,
  MAX_LOG_LINE_BYTES,
  MAX_LOG_FILE_BYTES,
  DIAGNOSTIC_LOG_FILE_CAP_MESSAGE,
  nodeDiagnosticLogFs,
  diagnosticLogFileName,
  formatDiagnosticLogLine,
  normalizeDiagnosticLogRecord,
  capDiagnosticLogLine,
  diagnosticLogDateKey,
  selectDiagnosticLogsToDelete,
  appendDiagnosticLog,
  pruneDiagnosticLogs,
  type DiagnosticLogFs,
  type DiagnosticLogEnv,
} from './diagnostic-log';

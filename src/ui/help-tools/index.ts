// UI layer (HB-8 / HB-9): public barrel for the ツール / ヘルプ command wiring.
//
// One controller that registers the ToolsSettings / ToolsSearch / HelpAbout /
// HelpShortcuts / HelpDiagnostics handlers on the shared command registry (教訓
// 5.13) and renders the views they open. Mounted in the App overlay alongside the
// other command-registering controllers (file-ops, add, knife).

export {
  HelpToolsController,
  type HelpToolsControllerProps,
} from './HelpToolsController';

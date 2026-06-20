// UI/session state layer (U16): public barrel.
//
// The thin Zustand store, the domain bridge, the session value types, the
// settings boundary, and the injected existence contract. Framework-free at the
// core (`zustand/vanilla`); React binds separately via `useStore` (技術方針 2.5).

export {
  type SessionStore,
  type SessionStoreState,
  type SessionStoreActions,
  type CreateSessionStoreOptions,
  type SettingsChange,
  type TimeChangeSource,
  TIME_CHANGE_SOURCE,
  createSessionStore,
} from './store';

export {
  type ActiveFeature,
  type VertexSelectionContext,
  type Camera,
  type EditMode,
  type ToolId,
  type DisplayControl,
  type DisplayFocus,
  EDIT_MODE,
  DEFAULT_CAMERA,
  DEFAULT_DISPLAY_CONTROL,
  NO_DISPLAY_FOCUS,
  asToolId,
  vertexSelectionContextOf,
} from './session';

export {
  type SettingsScope,
  type ProjectSettings,
  type AppSettings,
  type ProjectSettingKey,
  type AppSettingKey,
  type SettingKey,
  type ColorHex,
  type PaletteThemeId,
  SETTINGS_SCOPE,
  PROJECT_SETTING_KEYS,
  APP_SETTING_KEYS,
  classifySettingKey,
  isProjectSettingKey,
  isAppSettingKey,
  clampRenderFps,
  MIN_RENDER_FPS,
  MAX_RENDER_FPS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_TIMELINE_MIN,
  DEFAULT_TIMELINE_MAX,
} from './settings';

export {
  type ExistenceResolver,
  type FeatureExistsAt,
  type VertexExistsAt,
  ALWAYS_PRESENT_RESOLVER,
} from './existence';

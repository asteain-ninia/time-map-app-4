// `test-lesson-rules.mjs` の型。

export declare const DEV_DEPENDENCY_FILES: readonly string[];
export declare const CORE_MODULES: readonly string[];
export declare const RAW_TEXT_READ_FILES: readonly string[];
export declare const RAW_TEXT_READ_EXEMPT_FILES: readonly string[];
export declare function rawTextReadRestrictedSyntax(): readonly { selector: string; message: string }[];
export declare const SCAN_TEST_FILE_PATTERN: RegExp;
export declare const SCAN_FIXTURE_FILE_PATTERN: RegExp;
export declare const TEXT_QUERY_NAME_PATTERN: RegExp;
export declare const TEXT_LOCK_NOTE: string;
export declare const CAST_NOTE: string;
export declare const VIOLATION_LIMITS: {
  readonly textQueryLiterals: number;
  readonly domainLiteralCasts: number;
};
export declare const SNAPSHOT_PATH_TEMPLATE: string;
export declare const SNAPSHOT_FILES: Readonly<Record<string, readonly string[]>>;
export declare const SYNTHETIC_LOAD_LIMIT_MS: number;

// `ui-text-rule.mjs` の型（単体の走査 `src/ui/shell/ui-text-tables.test.ts` が読み込む）。

export declare const UI_TEXT_CHAR_CLASS: string;
export declare const UI_TEXT_ATTRIBUTES: readonly string[];
export declare const UI_TEXT_TABLE_FILES: readonly string[];
export declare const UI_TEXT_EXEMPT_FILES: readonly string[];
export declare function globToRegExp(glob: string): RegExp;
export declare function isUiTextTableFile(relPath: string): boolean;
export declare function isUiTextExemptFile(relPath: string): boolean;
export declare function uiTextRestrictedSyntax(): readonly { selector: string; message: string }[];

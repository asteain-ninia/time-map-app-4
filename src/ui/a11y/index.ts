// UI layer (a11y): public barrel for the shared keyboard-a11y helpers.
//
// One place for the modal focus-trap keydown handler and the tablist arrow-key
// math so every dialog / tablist reuses the SAME behaviour (教訓 5.13 単一の真実源),
// never a re-inlined copy.

export { useModalKeydown } from './focus-trap';
export { nextTabForArrow } from './tablist';

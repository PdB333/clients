export const AUTOTYPE_SEQUENCE_MODES = {
  USER_TAB_PASS: "user_tab_pass",
  USER_TAB_PASS_ENTER: "user_tab_pass_enter",
} as const;

export type AutotypeSequenceMode =
  (typeof AUTOTYPE_SEQUENCE_MODES)[keyof typeof AUTOTYPE_SEQUENCE_MODES];

export const DEFAULT_AUTOTYPE_SEQUENCE_MODE: AutotypeSequenceMode =
  AUTOTYPE_SEQUENCE_MODES.USER_TAB_PASS;

export function isAutotypeSequenceMode(value: unknown): value is AutotypeSequenceMode {
  return Object.values(AUTOTYPE_SEQUENCE_MODES).includes(value as AutotypeSequenceMode);
}

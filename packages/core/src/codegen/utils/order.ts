/**
 * The order generated output is written in: by UTF-16 code unit, as a plain `.sort()` orders
 * strings, so it is the same bytes on every machine. `localeCompare` follows the machine's LANG
 * under node (Danish sorts `aa` after `z`), so two developers would regenerate different files
 * from one tables file (F40); comb/no-locale-compare refuses it in src.
 */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

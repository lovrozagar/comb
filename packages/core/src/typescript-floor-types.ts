/**
 * What a TypeScript older than 5.7 reads for every subpath of comb: nothing (KT2 of r22b).
 *
 * comb's declarations use `NoInfer` (TypeScript 5.4) and `Uint8Array<ArrayBuffer>` (5.7). An older
 * compiler with `skipLibCheck` on, as every starter template sets it, reads each as `any` and drops
 * the check it carries with no error: a misspelled transition, a `random` that takes no bytes. Each
 * export's `types@>=5.7` condition names the real declarations, and the plain `types` condition after
 * it names this file, which declares no module, so an older compiler fails at each import with
 * TS2306, naming this file, in the project's own file. Upgrade to TypeScript 5.7 or later.
 */

/** The floor itself: a TypeScript that reads this file is older than comb supports */
declare namespace comb_needs_TypeScript_5_7_or_later {}

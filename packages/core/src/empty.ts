/** Shared frozen empties, so a default argument allocates nothing. Internal: not exported from any entry point. */
// oxlint-disable-next-line typescript/no-explicit-any
export const EMPTY_OBJ = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.create(null)) as Record<string, any>
// oxlint-disable-next-line typescript/no-explicit-any
export const EMPTY_ARR = /* @__PURE__ */ Object.freeze([]) as readonly any[]

/** The cursor secret the tests seal and open with: 32 bytes and more, as a real one is */
export const CURSOR_SECRET = "comb-test-cursor-secret-0123456789abcdef"

/** The list the tests' cursors belong to, as an app names a route and tenant */
export const CURSOR_SCOPE = "test:list"

/** The options every list helper takes, under the test secret and scope */
export const SEALED = { cursorScope: CURSOR_SCOPE, cursorSecret: CURSOR_SECRET } as const

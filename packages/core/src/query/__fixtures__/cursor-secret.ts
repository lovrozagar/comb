/** The cursor secret the tests sign and verify with: 32 bytes and more, as a real one is */
export const CURSOR_SECRET = "comb-test-cursor-secret-0123456789abcdef"

/** The options every list helper takes, under the test secret */
export const SIGNED = { cursorSecret: CURSOR_SECRET } as const

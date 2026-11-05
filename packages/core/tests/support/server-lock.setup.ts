/**
 * Every test of the Postgres projects runs holding the shared test server's lock shared, so every
 * check's replay reads the server's catalogs with no server-wide write of another test inside its
 * reads (server-lock.ts). Its hooks run first before each test and last after it.
 */
import { afterAll, afterEach, beforeEach } from "vitest"
import { fileLock, SERVER_LOCK_WAIT_MS } from "./server-lock.ts"

beforeEach(fileLock.reading, SERVER_LOCK_WAIT_MS)
afterEach(fileLock.doneReading)
afterAll(fileLock.end)

/**
 * Every unit test file runs with comb's Postgres parser loaded, as every comb path that classifies
 * a Postgres migration loads it first (pg-tree.ts). pg-tree.test.ts checks the refusal without it
 * on a fresh module.
 */
import { loadPostgresParser } from "../../src/migrate/core/pg-parser.ts"

await loadPostgresParser()

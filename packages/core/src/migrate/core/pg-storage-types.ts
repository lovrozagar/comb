/**
 * Where Postgres keeps a relation's rows, as the history shows it (pg-storage.ts) and as the target's
 * catalog says it (pg-live-storage.ts). Types only, so the declarations parse.ts and classify.ts
 * publish reach no further.
 */

/**
 * Where a table or materialized view keeps its rows, as far as the history shows it:
 * whether it is logged, and its access method and tablespace, each undefined where the history
 * leaves it to the target (a temporary table, one made without USING or TABLESPACE, SET ACCESS
 * METHOD DEFAULT)
 */
type Storage = { accessMethod: string | undefined; logged: boolean | undefined; tablespace: string | undefined }

/** Where the target keeps its tables' and materialized views' rows, and its indexes', by key */
type Placed = { indexes: ReadonlyMap<string, string>; relations: ReadonlyMap<string, Storage> }

/** Where the target's catalog says its relations are, and the statement of the history its applied files end before */
type Placing = { at: number; placed: Placed }

export type { Placed, Placing, Storage }

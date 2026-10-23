/**
 * One database and one pending file that runs every path of the proof's engine pass: a backfill, an
 * update a trigger watches, an insert, a temp table, a delete, Atlas's rebuild and writes to an FTS5
 * table. The proof copy and the target's own apply of the file must end in the same schema and rows.
 */

/** The database before the file, its rows included */
export const START = `CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
CREATE TABLE sessions (id INTEGER PRIMARY KEY, uid INTEGER);
CREATE TABLE log (note TEXT);
CREATE TRIGGER logout AFTER UPDATE OF email ON users BEGIN DELETE FROM sessions WHERE uid = NEW.id; INSERT INTO log VALUES ('out ' || NEW.id); END;
CREATE TABLE k (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT);
CREATE VIRTUAL TABLE notes USING fts5(body);
INSERT INTO users VALUES (1, 'a@x.io'), (2, 'b@x.io'), (3, NULL);
INSERT INTO sessions VALUES (1, 1), (2, 2), (3, 3);
INSERT INTO k VALUES (1, 'x', 'y'), (2, 'z', NULL);
INSERT INTO notes (rowid, body) VALUES (1, 'first');`

/** The pending file */
export const FILE = `ALTER TABLE users ADD COLUMN tier TEXT;
UPDATE users SET tier = 'free' WHERE id > 1;
UPDATE users SET email = 'c@x.io' WHERE id = 3;
INSERT INTO users (email) VALUES ('n@x.io');
CREATE TEMP TABLE scratch AS SELECT id FROM users;
DELETE FROM sessions WHERE id IN (SELECT id FROM scratch WHERE id = 1);
CREATE TABLE new_k (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT, c TEXT);
INSERT INTO new_k (id, a, b) SELECT id, a, b FROM k;
DROP TABLE k;
ALTER TABLE new_k RENAME TO k;
INSERT INTO notes (body) VALUES ('second');
DELETE FROM notes WHERE rowid = 1;
INSERT INTO notes (notes) VALUES ('optimize');`

/** Reads rows from one database, each as its columns by name */
export type Read = (sql: string) => Promise<Array<Record<string, unknown>>>

/**
 * A database as text: every object of main's and temp's schema, then every row of every main table,
 * shadow tables included, each value as SQLite quotes it
 */
export async function stateOf(read: Read): Promise<string[]> {
	const main = await read("SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name")
	const temp = await read("SELECT type, name, tbl_name, sql FROM temp.sqlite_schema ORDER BY type, name")
	const out = [...main, ...temp].map((row) => JSON.stringify(row))
	for (const { name } of main.filter((row) => row["type"] === "table")) {
		const table = `"${String(name).replaceAll('"', '""')}"`
		const columns = (await read(`PRAGMA main.table_info(${table})`)).map((row) => `quote("${String(row["name"])}")`)
		const rows = await read(`SELECT ${columns.join(" || ',' || ")} AS r FROM main.${table} ORDER BY 1`)
		out.push(`${String(name)}: ${rows.map((row) => String(row["r"])).join(" | ")}`)
	}
	return out
}

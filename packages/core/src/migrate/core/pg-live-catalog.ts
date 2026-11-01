/**
 * The one catalog read a Postgres baseline makes (pg-live-objects.ts), in one round trip, of what
 * Atlas OSS leaves out of its comparison. Each row says `what` it is; `how` spells its settings as
 * the history's are spelled (P10 of r18), so the two compare as text.
 *
 * - The target schema's functions and procedures, but an extension's (a member of it through
 *   pg_depend, deptype e) and one another object makes (deptype i: a range type's constructors),
 *   each with its input argument types as the parser spells them (the catalog's type name, an array
 *   as its element's and [], the schema left out for pg_catalog and the target's).
 * - Its tables' triggers, but the internal ones a constraint makes, with tgtype and whether they
 *   fire: O and A do, D and R (replica only) do not, as the history reads ENABLE and DISABLE (P13);
 *   a partition's clone of its parent's trigger is Postgres's, so it is left out (tgparentid).
 * - Its views, materialized views and sequences, but an extension's and a sequence a column owns (a
 *   serial's or an identity's, deptype a or i), a sequence with its settings; each table's policies,
 *   with their command, roles and whether they are permissive (P9 of the 0.15.0 review).
 * - Its domains, composite and range types and collations, but an extension's; each table's rules but
 *   a view's own; each table's row level security where it is on; every extension but plpgsql.
 */
export const CATALOG = `SELECT 'routine' AS what, p.proname AS name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind, NULL AS on_table,
(SELECT coalesce(string_agg(CASE WHEN tn.nspname IN ('pg_catalog', $1) THEN '' ELSE tn.nspname || '.' END || t.typname || CASE WHEN x.arr THEN '[]' ELSE '' END, ',' ORDER BY a.ord), '')
 FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(oid, ord)
 JOIN pg_catalog.pg_type at ON at.oid = a.oid
 CROSS JOIN LATERAL (SELECT at.typcategory = 'A' AND at.typelem <> 0 AS arr) x
 JOIN pg_catalog.pg_type t ON t.oid = CASE WHEN x.arr THEN at.typelem ELSE at.oid END
 JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace) AS signature,
NULL::int AS tgtype, NULL::boolean AS enabled, NULL::text AS how
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype IN ('e', 'i'))
UNION ALL
SELECT 'trigger', t.tgname, NULL, c.relname, NULL, t.tgtype::int, t.tgenabled IN ('O', 'A'), NULL
FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgparentid = 0
UNION ALL
SELECT 'relation', c.relname, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'sequence' END, NULL, NULL, NULL, NULL,
(SELECT 'start ' || s.seqstart || ', increment ' || s.seqincrement || ', min ' || s.seqmin || ', max ' || s.seqmax || ', ' || CASE WHEN s.seqcycle THEN 'cycle' ELSE 'no cycle' END
 FROM pg_catalog.pg_sequence s WHERE s.seqrelid = c.oid)
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('v', 'm', 'S')
AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND (d.deptype = 'e' OR (c.relkind = 'S' AND d.deptype IN ('a', 'i') AND d.refclassid = 'pg_catalog.pg_class'::regclass)))
UNION ALL
SELECT 'policy', p.polname, NULL, c.relname, NULL, NULL, NULL,
'for ' || CASE p.polcmd WHEN '*' THEN 'all' WHEN 'r' THEN 'select' WHEN 'a' THEN 'insert' WHEN 'w' THEN 'update' ELSE 'delete' END
 || ', to ' || (SELECT string_agg(r.name, ', ' ORDER BY r.name) FROM (SELECT CASE WHEN o = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(o)::text END AS name FROM unnest(p.polroles) o) r)
 || ', ' || CASE WHEN p.polpermissive THEN 'permissive' ELSE 'restrictive' END
FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
UNION ALL
SELECT 'kind', t.typname, CASE t.typtype WHEN 'd' THEN 'domain' WHEN 'r' THEN 'range type' ELSE 'composite type' END, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = $1 AND (t.typtype IN ('d', 'r') OR (t.typtype = 'c' AND (SELECT k.relkind FROM pg_catalog.pg_class k WHERE k.oid = t.typrelid) = 'c'))
AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
UNION ALL
SELECT 'kind', l.collname, 'collation', NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_collation l JOIN pg_catalog.pg_namespace n ON n.oid = l.collnamespace
WHERE n.nspname = $1
AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_collation'::regclass AND d.objid = l.oid AND d.deptype = 'e')
UNION ALL
SELECT 'rule', r.rulename, NULL, c.relname, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND r.rulename <> '_RETURN'
UNION ALL
SELECT 'rls', c.relname, NULL, NULL, NULL, NULL, NULL,
CASE WHEN c.relrowsecurity THEN 'enabled' ELSE 'disabled' END || ', ' || CASE WHEN c.relforcerowsecurity THEN 'forced' ELSE 'not forced' END
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND (c.relrowsecurity OR c.relforcerowsecurity)
UNION ALL
SELECT 'extension', e.extname, NULL, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_extension e WHERE e.extname <> 'plpgsql'`

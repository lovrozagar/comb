/**
 * The one catalog read a Postgres baseline makes (pg-live-objects.ts), in one round trip, of what
 * Atlas OSS leaves out of its comparison. Each row says `what` it is; `how` spells its settings as
 * the history's are spelled, so the two compare as text.
 *
 * - The target schema's functions and procedures, but an extension's (a member of it through
 *   pg_depend, deptype e) and one another object makes (deptype i: a range type's constructors),
 *   each with its input argument types as the parser spells them (the catalog's type name, an array
 *   as its element's and [], the schema left out for pg_catalog and the target's).
 * - Its tables' triggers, but the internal ones a constraint makes, with tgtype and whether they
 *   fire: O and A do, D and R (replica only) do not, as the history reads ENABLE and DISABLE;
 *   a partition's clone of its parent's trigger is Postgres's, so it is left out (tgparentid).
 * - Its views, materialized views and sequences, but an extension's and a sequence a column owns (a
 *   serial's or an identity's, deptype a or i), a sequence with its settings; each table's policies,
 *   with their command, roles and whether they are permissive.
 * - Its domains, composite and range types and collations, but an extension's; each table's rules but
 *   a view's own; each table's row level security where it is on; every extension but plpgsql.
 * - The role the read connects as, which a policy's CURRENT_USER names.
 * - As `other` labels: its aggregates; each function or procedure that is SECURITY DEFINER;
 *   its operators; each cast over one of its types or functions; each view's and materialized view's
 *   options (security_invoker, security_barrier, check_option); each materialized view's indexes; each
 *   table's replica identity where it is not the default. As `platform` labels, database-wide, which a
 *   platform may hold of its own: event triggers and publications. Each but an extension's.
 */
import type { LiveObjects } from "./pg-live-types.ts"
/** The input argument types of a routine `p`, as the parser spells them (see the routine arm) */
const SIGNATURE = `(SELECT coalesce(string_agg(CASE WHEN tn.nspname IN ('pg_catalog', $1) THEN '' ELSE tn.nspname || '.' END || t.typname || CASE WHEN x.arr THEN '[]' ELSE '' END, ',' ORDER BY a.ord), '')
 FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(oid, ord)
 JOIN pg_catalog.pg_type at ON at.oid = a.oid
 CROSS JOIN LATERAL (SELECT at.typcategory = 'A' AND at.typelem <> 0 AS arr) x
 JOIN pg_catalog.pg_type t ON t.oid = CASE WHEN x.arr THEN at.typelem ELSE at.oid END
 JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace)`

export const CATALOG: string = `SELECT 'routine' AS what, p.proname AS name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind, NULL AS on_table,
${SIGNATURE} AS signature,
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
FROM pg_catalog.pg_extension e WHERE e.extname <> 'plpgsql'
UNION ALL
SELECT 'other', 'aggregate ' || p.proname || '(' || ${SIGNATURE} || ')', NULL, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.prokind = 'a' AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
UNION ALL
SELECT 'other', CASE p.prokind WHEN 'p' THEN 'procedure ' ELSE 'function ' END || p.proname || '(' || ${SIGNATURE} || ') security definer', NULL, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') AND p.prosecdef AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
UNION ALL
SELECT 'other', 'operator ' || o.oprname || '(' || coalesce(lt.typname, 'none') || ', ' || coalesce(rt.typname, 'none') || ')', NULL, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace
LEFT JOIN pg_catalog.pg_type lt ON lt.oid = o.oprleft LEFT JOIN pg_catalog.pg_type rt ON rt.oid = o.oprright
WHERE n.nspname = $1 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_operator'::regclass AND d.objid = o.oid AND d.deptype = 'e')
UNION ALL
SELECT 'other', 'cast (' || st.typname || ' as ' || tt.typname || ')', NULL, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_cast c JOIN pg_catalog.pg_type st ON st.oid = c.castsource JOIN pg_catalog.pg_type tt ON tt.oid = c.casttarget
LEFT JOIN pg_catalog.pg_proc cf ON cf.oid = c.castfunc
WHERE c.oid >= 16384 AND (st.typnamespace = $1::regnamespace OR tt.typnamespace = $1::regnamespace OR cf.pronamespace = $1::regnamespace)
AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_cast'::regclass AND d.objid = c.oid AND d.deptype = 'e')
UNION ALL
SELECT 'other', CASE c.relkind WHEN 'v' THEN 'view ' ELSE 'materialized view ' END || c.relname || ' (' || array_to_string(c.reloptions, ', ') || ')', NULL, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') AND c.reloptions IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
UNION ALL
SELECT 'other', 'index ' || ic.relname || ' on ' || mc.relname, NULL, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid JOIN pg_catalog.pg_class mc ON mc.oid = i.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = mc.relnamespace
WHERE n.nspname = $1 AND mc.relkind = 'm'
UNION ALL
SELECT 'other', 'replica identity on ' || c.relname || ' (' || CASE c.relreplident WHEN 'f' THEN 'full' WHEN 'n' THEN 'nothing' ELSE 'index' END || ')', NULL, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relreplident <> 'd'
UNION ALL
SELECT 'platform', 'event trigger ' || e.evtname, NULL, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_event_trigger e WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_event_trigger'::regclass AND d.objid = e.oid AND d.deptype = 'e')
UNION ALL
SELECT 'platform', 'publication ' || pb.pubname, NULL, NULL, NULL, NULL, NULL, NULL
FROM pg_catalog.pg_publication pb
UNION ALL
SELECT 'user', current_user::text, NULL, NULL, NULL, NULL, NULL, NULL`

/**
 * What each arm of CATALOG compares, in the arms' order, as a refusal names it: the one list COMPARED
 * is written from, held to CATALOG's arms by its test, so an arm cannot go unnamed
 */
export const ARM_KINDS: ReadonlyArray<readonly [what: string, kinds: readonly string[]]> = [
	["routine", ["functions", "procedures"]],
	["trigger", ["triggers"]],
	["relation", ["views", "materialized views", "sequences"]],
	["policy", ["policies"]],
	["kind", ["domains", "composite types", "range types"]],
	["kind", ["collations"]],
	["rule", ["rules"]],
	["rls", ["row level security"]],
	["extension", ["extensions"]],
	["other", ["aggregates"]],
	["other", ["SECURITY DEFINER"]],
	["other", ["operators"]],
	["other", ["casts"]],
	["other", ["views' options"]],
	["other", ["materialized views' indexes"]],
	["other", ["replica identity"]],
	["platform", ["event triggers"]],
	["platform", ["publications"]],
	["user", []],
]

/** What a baseline compares itself, as its refusals name it */
export const COMPARED: string = /* @__PURE__ */ (() => {
	const kinds = ARM_KINDS.flatMap(([, named]) => named)
	return `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1) as string}`
})()

/** `live` read on dev, with dev's role named as the target's wherever a policy names it (the reviewer's addition A) */
export function asTarget(live: LiveObjects, targetUser: string): LiveObjects {
	const devUser = live.user
	if (devUser === targetUser) return live
	const spelled = /^(for \w+, to )(.*)(, (?:permissive|restrictive))$/
	const policies = new Map(
		[...live.policies].map(([table, each]) => [
			table,
			new Map(
				[...each].map(([name, how]) => {
					/* the catalog read spells every policy so (CATALOG) */
					const [, head, roles, tail] = spelled.exec(how) as RegExpExecArray as unknown as [
						string,
						string,
						string,
						string,
					]
					const mapped = roles
						.split(", ")
						.map((role) => (role === devUser ? targetUser : role))
						.sort()
					return [name, `${head}${mapped.join(", ")}${tail}`]
				}),
			),
		]),
	)
	return { ...live, policies, user: targetUser }
}

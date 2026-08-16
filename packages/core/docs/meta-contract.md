# The comb meta contract

Status: v1, implemented in `@lovrozagar/comb` (`packages/core`).

Consumer of record: honey's `.metaSpec()` policy layer — see
`@lovrozagar/honey` `docs/meta-spec.md` §2.3.

## 1. What this is, and the boundary it keeps

```
comb                     honey                        oat
schema + query truth ──► maps facts to tags ────────► tests the live API
  stamps x-comb          x-entity, x-query, …          checks unlocked
```

comb publishes **facts about tables and queries**. honey decides **which documents those
facts appear in**, and under what tag names. oat consumes the resulting document.

comb's payload therefore uses comb's own vocabulary — `generated`, `immutable`, `softDelete` —
never oat's tag names (`x-generated`, `x-immutable`, `x-soft-delete`). Encoding the tag names
here would weld three projects into one: oat could not rename a tag, and honey could not target
a different tester, without a comb release. The mapping lives in exactly one place, honey's
policy, and that is what lets any of the three be replaced.

### The property that makes this worth building

`CombQueryMeta` is produced **from the same config object that parses the request at runtime**,
inside `createListQuerySchema`. There is no second declaration to keep in sync, so the document
cannot drift from behavior — not "should not", cannot.

### The constraint that bounds it

Facts are derived from **schema and table definitions** — a separate, hand-reviewed layer that a
handler can still fail to honor. That disagreement is precisely the finding a contract tester
should report. Nothing here is derived from observed handler behavior; that would make the
tester self-confirming and it would report clean forever.

## 2. The wire format

One reserved key, `x-comb`, carrying a flat discriminated union.

```jsonc
{
	"type": "object",
	"properties": { "id": { "type": "string" } /* … */ },
	"x-comb": {
		"v": 1,
		"kind": "entity",
		"name": "post",
		"identity": "id",
		"generated": ["id", "created_at", "updated_at"],
		"immutable": ["id", "created_at"],
		"softDelete": "deleted_at",
		"tenantColumn": null,
	},
}
```

```jsonc
{
	"x-comb": {
		"v": 1,
		"kind": "query",
		"filterable": ["status", "title", "created_at"],
		"sortable": ["created_at", "title"],
		"searchable": null,
		"selectable": ["id", "status", "title", "created_at"],
		"maxLimit": 100,
		"defaultOrder": "created_at.desc",
		"stableTiebreak": "id",
		"grammar": "postgrest",
	},
}
```

**Why one key rather than `x-comb-entity` / `x-comb-query`:** one reserved name is one collision
surface, the version is stated once, and honey needs exactly one `schema` policy entry whose
`expand` switches on `kind`. Two keys would double all three.

**Why the `x-` prefix** when this is a fact envelope and not an OpenAPI extension: if it ever
does reach a document verbatim — someone dumps the JSON Schema straight into `components` — it is
a legal extension rather than an invalid key. It is also greppable across all three repos.

`v` and `kind` are flat rather than wrapping a nested `meta` object so that consumers get an
ordinary discriminated union: `if (m.kind === "entity")` narrows, with no extra hop.

## 3. Producer API

```ts
import { combMeta } from "@lovrozagar/comb/meta"

const postReadSchema = z.object({/* … */}).meta(
	combMeta({
		kind: "entity",
		name: "post",
		identity: "id",
		generated: ["id", "created_at", "updated_at"],
		immutable: ["id", "created_at"],
		softDelete: "deleted_at",
		tenantColumn: null,
	}),
)
```

`combMeta()` returns `{ "x-comb": … }` — an object to spread into or pass to `.meta()`. It
stamps `v` itself; callers never write the version.

Two call sites inside comb produce it automatically:

| Producer                                      | Stamps                                  | Source of truth               |
| --------------------------------------------- | --------------------------------------- | ----------------------------- |
| `generateDtos` (`codegen/generators/dtos.ts`) | `CombEntityMeta` on the **read** schema | `TableMeta` from the analyzer |
| `createListQuerySchema` (`query/schema.ts`)   | `CombQueryMeta` on the returned schema  | its own `config` argument     |

### 3.1 Stamp the schema you return, not the one you build from

Zod carries `.meta()` in a registry keyed by the schema instance. `z.toJSONSchema` reads it off
whichever instance you hand it, and **a transform/pipe does not forward the base's metadata to
the output view**:

| Stamped on                                    | `toJSONSchema(io:"input")` | `toJSONSchema(io:"output")` |
| --------------------------------------------- | -------------------------- | --------------------------- |
| the returned pipe                             | present                    | present                     |
| the base object, before `.transform().pipe()` | present                    | **lost**                    |

`createListQuerySchema` returns `piped.pipe(outputSchema)`, so the stamp goes on that final
value. This is verified by test, because it is silent when wrong: honey would read `input.search`
successfully in development and emit nothing for a consumer reading the output view.

## 4. Reader API, and the versioning story

```ts
import { readCombMeta, readCombEntityMeta, readCombQueryMeta, COMB_META_VERSION } from "@lovrozagar/comb/meta"

const meta = readCombEntityMeta(jsonSchema) // CombEntityMeta | null
const any = readCombMeta(jsonSchema, { maxVersion: 1 })
```

The reader takes a **JSON Schema object** and reads `x-comb` off its root. It does not unwrap
`items` — honey already does that, documented in its §2.3, and a fact should have one unwrapping
owner rather than two that can disagree.

### 4.1 What `v` means

`v` is a single integer, and it is bumped **only on a breaking change**: a field removed, or a
field whose meaning changed. **Adding a field never bumps `v`.** That is the whole rule, and it
is what lets comb and honey ship independently.

Two obligations follow, and the reader enforces both:

- **Forward compatibility — ignore unknown fields.** A v1 reader handed a payload carrying fields
  it has never heard of keeps the ones it knows. This is what makes additive growth free.
- **Backward compatibility — refuse, do not guess.** A reader handed `v` greater than its
  `maxVersion` returns `null`, with a diagnostic. It does **not** attempt a partial read.

### 4.2 Why refusing beats guessing

This is the decision most likely to be regretted later, so the reasoning is worth stating.

A _missing_ tag and a _wrong_ tag are not equally bad. oat's precedence is explicit tag →
heuristic → skip with a coverage gap. A missing `x-query` costs a warning and some wasted probes
against un-indexed columns. A **wrong** `x-query` — say a v2 payload where `filterable` changed
meaning, read optimistically by a v1 reader — silently narrows what oat tests, and the run
comes back green. Under-testing that reports success is the one outcome a contract tester must
never produce.

So: on a version it does not understand, comb's reader degrades to the state oat handles well
(no tag, visible gap) rather than the state it handles badly (confident and wrong).

The mirror case is safe and needs no ceremony: an **older** payload read by a newer consumer is
just missing fields. Every field a later version adds is therefore optional at the reader, and
`null` is used — not absence — wherever "known to be nothing" must be distinguished from
"this producer did not say". `softDelete: null` means _no tombstone column_;
`searchable: null` means _comb does not know at this layer_ (§6.1).

## 5. Collision rules

`.meta()` in Zod 4 is a **shallow merge onto a clone**. Verified:

| Sequence                                              | Result                              |
| ----------------------------------------------------- | ----------------------------------- |
| comb stamps, user adds `.meta({ description })`       | both present; `x-comb` survives     |
| comb stamps, user calls `.describe()`                 | both present                        |
| user stamps their own `x-comb` after comb             | **user wins** — last write, per key |
| `.optional()` / `.nullable()` around a stamped object | survives                            |
| **`.extend()` on a stamped object**                   | **`x-comb` is dropped**             |

The last row is the trap. `.extend()` builds a new object type and does not carry the registry
entry, so a consumer who extends a generated read schema loses the entity facts **silently** —
the document simply has no `x-entity`, and oat reports a coverage gap for an entity that was
fully described one call earlier.

Mitigation, in order of preference:

1. Stamp after extending: `base.extend({ … }).meta(combMeta({ … }))`.
2. `carryCombMeta(from, to)` — re-stamps `to` with whatever `from` carried, exported for exactly
   this case.

**Decision: merge, last write wins, reader validates.** Not throw — comb has no hook to throw
from. `.meta()` is Zod's API, called on a schema comb has already returned; intercepting it would
mean wrapping the schema in something that is no longer a plain Zod type, which costs every
consumer more than the case is worth. Not clobber either: silently discarding a user's
`description` to protect a key of ours would be the same disrespect in the other direction.

So the reserved key behaves like any other metadata key, and the safety lives in the reader — a
malformed or unrecognised `x-comb` is refused with a diagnostic (§4.2), never partially trusted.

A user who deliberately writes their own `x-comb` is taken at their word. It is a reserved key
under an `x-` prefix carrying a documented version field; overwriting it is a considered act, not
an accident, and comb's reader will validate the shape and refuse it if malformed.

## 6. What comb can and cannot know

Being explicit about the gaps is the point; a fact comb guesses at is worse than one it omits.

### 6.1 `searchable` is `null`, deliberately

`createListQuerySchema`'s config is `{ sort, filter, fields, pagination }`. There is **no
`search` key**. The `q` parameter is accepted unconditionally by the schema and is resolved much
later, at `buildListQuery({ search: likeSearch(col) })` — a different call site, often a different
file.

So the layer that owns the stamp does not know which columns are searchable. Adding a
`search: string[]` to the config purely so the stamp could carry it would produce a declaration
nothing validates against — the exact self-confirming failure this contract exists to avoid, one
layer up. `searchable` is therefore `null` from `createListQuerySchema`, and populated only from
`defineListQuery`, whose `ListQuerySchemaConfig` **does** carry `search` and builds
`capabilities.searchFields` from it.

Making it load-bearing at the schema layer — having `createListQuerySchema` reject `q` when no
column is searchable — is the right fix and is tracked as future work, not smuggled in here.

### 6.2 Foreign keys are immutable, and nearly went unpublished

The first draft derived `immutable` from `nomutate` alone, as the brief described. The parity test
in §9 rejected it: `author_id` was absent from the generated update body but not on the published
list.

The cause is a rule stated only inside `generateFieldSchema`, several hundred lines from anything
named "immutable":

```ts
/* FK fields excluded from Update schemas - set once at creation */
if (isUpdateSchema) return null
```

Foreign keys are immutable in comb by design, and publishing `immutable` without them would have
told a consumer that `project_id` and `author_id` are freely mutable — the fields a tenant-boundary
attack tries first. The `patch.immutable-field-rejected` check would have run, passed, and covered
nothing.

The fix is not a longer predicate. `deriveEntityMeta` now takes the field set the generator
**actually emitted** and treats whatever is missing as immutable, so the two cannot diverge again:

```ts
const updateFields = new Set(fields.filter((f) => f.type === "update").map((f) => f.key))
deriveEntityMeta(meta, updateFields)
```

`isExcludedFromUpdate` survives as the documented approximation for callers holding only a
`TableMeta`, with its limitation stated at the definition. This is the same lesson as §7, from the
other direction: a fact restated in a second place is a fact that will drift.

### 6.3 `tenantColumn` is declared, never inferred

This is the highest-value field in the contract. Downstream, a missing tenant declaration is why
oat reports a cross-tenant read as `AMBIGUITY` rather than `SECURITY` — the strongest check in the
suite is advisory for want of one fact.

comb **can** know it, but only if the table says so:

```ts
export const post = sqliteTable("post", {
	id: c.id("pst"),
	org_id: c.ref("org_id", { tenant: true }).references(() => org.id),
	title: c.text("title"),
})
```

**Why not infer it.** comb sees that `org_id` is a foreign key. It does not see that `org` is the
tenant rather than an ordinary parent — a `post` belongs to an `author` and to an `org` by the
identical mechanism. Every available signal is a name: match `org|organization|tenant|workspace|
account|project`, and hope. That is precisely oat's own documented fallback, so inferring here
would not add information — it would move the same guess one layer earlier and relabel it a
declaration, which is strictly worse. A consumer treats an explicit `x-tenant` as authoritative and
stops applying its own heuristic; a wrong value therefore makes it confident about the wrong
boundary. Missing is recoverable, wrong is not.

`{ tenant: true }` is a different kind of fact: someone wrote it, a reviewer read it, and it sits
in the same file as the column. That is the provenance the whole contract depends on (§1).

**Two declarations yield null**, and `validateTables` rejects the table. A table scopes to one
tenant or none; with two there is no safe resolution, and publishing either would be a coin flip
presented as a fact.

**Until an app adopts the annotation, `tenantColumn` is `null` and honey should fill it.** That
composes correctly without further coordination: comb's stamp is schema-derived (rank 1), a route
or middleware contribution in honey is route meta (rank 2), and route meta wins. So an app can
migrate column by column, and the two sources never fight. honey also holds a fact comb never will —
which _path parameter_ carries the tenant — so `x-tenant` staying honey's to emit is right even
once comb can name the column.

### 6.4 Composite primary keys

`identity` is a single column. `TableMeta.hasCompositePrimaryKey` exists, and for such a table
there is no single identity to publish. comb omits the entity stamp entirely rather than picking
one column, and warns. A composite-key entity is not addressable by a single-id item route, so
the downstream checks were not going to apply regardless.

## 7. `stableTiebreak`, and a bug it surfaced

`stableTiebreak` is the column keyset pagination breaks ties on. oat calls it load-bearing:
without it, page-walk checks report phantom gaps and duplicates.

comb's SQLite cursor builder resolves it as `getTableColumns(table)["id"]` — the **JavaScript
property name**, hardcoded — and `buildCursorWhere` returns `null` when that lookup misses:

```ts
const idCol = columns["id"] as SQLiteColumn | undefined
if (!sortCol || !idCol) return null
```

A `null` here is not an error. It means no cursor predicate is added, so the query returns the
first page again — **rows silently duplicate and rows are silently skipped across pages**. Any
table whose primary key is declared under a different property name (`{ pk: c.id("usr") }`) has
broken cursor pagination today, with no diagnostic.

So `stableTiebreak` is published as `"id"`, matching what the builder actually does, and
`validateTables()` now fails when a table's primary-key property is not named `id`. Publishing
the fact forced the invariant to be stated, which is the argument for doing this at all.

## 8. Worked example, end to end

**1 — comb table definition**

```ts
export const post = sqliteTable("post", {
	id: c.id("pst"),
	status: c.enum("status", ["draft", "published"]).notNull().default("draft"),
	title: c.text("title", { max: 200 }),
	internal_note: c.text("internal_note", { private: true }),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
	deleted_at: c.deletedAt("deleted_at"),
})
```

**2 — generated DTO, stamped by `generateDtos`**

```ts
export const postReadSchema = z
	.object({
		id: z.string().meta({ examples: ["pst_01jqx…"] }),
		status: z.enum(["draft", "published"]),
		title: z.string().max(200),
		...timestampsCreatedUpdatedDeletedRead,
	})
	.meta(
		combMeta({
			kind: "entity",
			name: "post",
			identity: "id",
			generated: ["id", "created_at", "updated_at", "deleted_at"],
			immutable: [],
			softDelete: "deleted_at",
			tenantColumn: null,
		}),
	)
```

**3 — what honey reads**, via one `schema` policy entry:

```ts
.metaSpec({
  schema: {
    "x-comb": {
      from: ["output", "input.search"],
      expand: (m) => {
        const f = readCombMeta(/* the JSON Schema root honey already has */)
        if (f?.kind === "entity") return {
          "x-entity": { name: f.name, identity: f.identity },
          "x-generated": f.generated,
          "x-immutable": f.immutable.length ? f.immutable : undefined,
          "x-soft-delete": f.softDelete ?? undefined,
          "x-tenant": f.tenantColumn ?? undefined,
        }
        if (f?.kind === "query") return {
          "x-query": {
            filterable: f.filterable, sortable: f.sortable,
            selectable: f.selectable,
            ...(f.searchable ? { searchable: f.searchable } : {}),
            maxLimit: f.maxLimit, defaultOrder: f.defaultOrder,
            stableTiebreak: f.stableTiebreak, grammar: f.grammar,
          },
        }
        return undefined
      },
    },
  },
})
```

Note `searchable` is spread conditionally: `null` must become an **absent** key, not
`searchable: null`, so oat falls back to its own narrowing rather than reading an empty list as
"nothing is searchable".

**4 — what oat receives**

```yaml
x-entity: { name: post, identity: id }
x-generated: [id, created_at, updated_at, deleted_at]
x-soft-delete: deleted_at
x-query:
  filterable: [status, title, created_at]
  sortable: [created_at, title]
  selectable: [id, status, title, created_at]
  maxLimit: 100
  defaultOrder: created_at.desc
  stableTiebreak: id
  grammar: postgrest
```

Unlocked: `spec.declared-filterable-is-filterable`, `spec.declared-sortable-is-sortable`,
`spec.declared-selectable-is-selectable`, `softdelete.absent-from-default-list`. Sharpened: every
other query check now probes only declared columns.

`internal_note` is absent from every list because `private: true` already removed it from the
read DTO — the stamp is derived from the same field set, so it cannot disagree.

## 8.1 Two descriptors, one operation — an open consumer-side issue

A list operation carries both descriptors: the entity one rides the output schema, the query one
rides the search schema. Both use the single reserved key, by design.

honey resolves a schema entry by walking its `from` list and stopping at the **first source that
carries the key** (`meta-spec.ts:443-450` at `cd7eb5c`). With the default order — `output`,
`input.json`, `input.search`, … — the entity descriptor is found first and the query descriptor is
never read. No error is raised; `x-query` is simply absent.

**This is not comb's to fix by splitting the key.** Two keys would trade one silent drop for a
permanent second collision surface, a second version field, and a second policy entry, and honey
would still stop at the first hit for any future third descriptor. The single-key design holds; the
resolution is that a schema entry should collect from **every** source in `from`, not the first,
and invoke its `expand` per hit — which the discriminated `kind` already makes unambiguous.

Until then an app can work around it with two policy entries narrowed by `from`, if honey allows
the same source key twice; comb's side needs no change either way.

`tests/e2e/stamp-to-document.test.ts` pins comb's half: both stamps present, correct, and each
resolvable on its own schema, with the drop reproduced against a transcription of honey's own
search so the fix has a concrete case to satisfy.

## 9. Tests, and why they are shaped this way

`tests/unit/meta/` holds three files:

| File                    | Asserts                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `contract.test.ts`      | round-trips through `z.toJSONSchema`, collision rules, version refusal, malformed-payload rejection |
| `query-parity.test.ts`  | the published query facts against **the parser**, by driving real query strings                     |
| `entity-parity.test.ts` | the published entity facts against **the analyzer and the generated DTOs**                          |

The parity files deliberately do not compare the stamp to a second constant — that would only
prove two literals are equal. `query-parity` feeds `filter=<field>.eq.x` for every published
`filterable` field and requires the schema to accept it, then feeds an unpublished field and
requires rejection. `entity-parity` reads the generated update schema back off disk and checks
`immutable` against it **in both directions**, so neither list can quietly grow past the other.

The e2e file executes the generated DTO rather than string-matching it, so it covers the
`@lovrozagar/comb/meta` import the generator emits, and asserts placement for the three shapes that
actually occur: a bare item (root, depth 0), a bare array (under `items`, depth 1, still reachable
by honey's `search: "root"`), and a pagination envelope `{ articles: [Article], count, hasMore,
nextCursor }` (depth 2 — invisible to `"root"`, found by `"deep"`, well inside its limit of 6).
Ambiguity and dedup are pinned too: two _different_ entities at one depth is an error in honey, the
_same_ entity twice is not.

That shape has already paid twice: it caught the foreign-key omission in §6.2, and it caught
`selectable` publishing relation names that the parser rejects in the bare form (`select=author`
is a 400; only `select=author(name)` parses). Both were wrong in the first implementation, and
neither would have been caught by a test that restated the rule.

## 10. Publishing: source, not a build

comb ships TypeScript source (`"files": ["src"]`). A source-shipping package inherits the
**consumer's** strict flags, and `skipLibCheck` does not help, because it only covers `.d.ts`.

Measured, per flag, over `src/**`:

| Flag                                 | Errors before | After |
| ------------------------------------ | ------------- | ----- |
| `noUncheckedIndexedAccess`           | 0             | 0     |
| `noPropertyAccessFromIndexSignature` | 19            | 0     |
| `exactOptionalPropertyTypes`         | 32            | 0     |

All 51 were mechanical: dot access on index-signature types became bracket access, and optional
properties were widened from `p?: T` to `p?: T | undefined` — behavior-neutral, and more honest
about what the API already accepted. One call site into `@libsql/client` omits a key rather than
passing an explicit `undefined`, since that type is not ours to widen.

**Why fix the source rather than add a build.** Publishing declarations would hide these from
consumers while leaving comb's own internals loose, and it costs a real pipeline: 19 subpath
exports, `allowImportingTsExtensions` meaning every internal specifier ends in `.ts` and would
need rewriting, and a CLI whose shebang is `#!/usr/bin/env bun` running `.ts` directly. The
codegen path also benefits from consumers being able to read the source that produced their files.

**The durable rule, which is the part worth sharing with honey and flare:** a package that ships
source must compile under the union of the strict flags its consumers might set, and must prove it
in CI. `bun run typecheck:strict` does that, and both workflows run it. The mechanism — fix or
build — then follows from measurement rather than from a guess. comb's exposure turned out to be
51 errors; honey's is reportedly ~480, dominated by `noUncheckedIndexedAccess`, which comb has
none of. Same rule, different answers, and that is the point: measure first.

**Export surface.** 19 entry points, down from 21. `./codegen/analyze` and `./migrate/drivers`
were dropped as redundant — `./codegen` and `./migrate` already re-export their contents — and
`./meta` was added. 0.x promises nothing about these; the contract in §4 is versioned separately
from the package, precisely so the two can move at different speeds.

## 11. Rejected alternatives

**A JSON sidecar file instead of Zod meta.** comb already generates `*.entities.gen.ts` and could
emit `entities.json`. Rejected as the _primary_ channel: a sidecar is a second artifact that can
drift from the schema honey actually serves, and honey would need a path convention to find it.
The stamp travels on the object honey already converts to JSON Schema, so there is nothing to
locate and nothing to keep in sync. A manifest remains worthwhile for consumers that are not
honey (§4.4 of the brief) — as a _projection_ of the same facts, not a second source.

**Encoding oat's tag names directly** (`x-soft-delete` in comb's payload, honey passing through).
Rejected per §1: it is fewer moving parts today and a three-way version lock forever.

**A separate key per fact** (`x-comb-entity`, `x-comb-query`, `x-comb-tenant`). Rejected: N
collision surfaces, N version fields, and N honey policy entries, for no gain over a discriminant.

**Optimistic partial reads of a newer `v`.** Rejected in §4.2 — under-testing that reports green
is the worst available outcome.

**Deriving `searchable` by inspecting the runtime search resolver.** That is behavior-derived, and
would make the tester self-confirming. §6.1.

## 12. Open questions

1. **Does honey want the reader, or the raw object?** comb exports `readCombMeta` so the version
   check has one implementation. If honey's `expand` receives the already-parsed root, it should
   call comb's reader rather than reaching for `value["x-comb"]` — otherwise the refuse-on-newer
   rule lives in two places and one of them will rot.
2. **`defaultOrder` when `sort` is empty.** `createListQuerySchema` falls back to
   `parsedSort = []` and the SQLite builder then defaults to `created_at desc`. Those two defaults
   are declared in different files and can diverge; currently the stamp reports the schema's view.
   Unifying them is worth doing before either is depended on.
3. **Terminal-state modeling (`x-async`).** Designed but not implemented: a `states:
{ values, terminal, success }` annotation on `c.enum()` would let `x-async`'s `until` /
   `successWhen` predicates be derived rather than hand-written, and is independently useful for
   state-transition validation on write. It needs a third argument on `c.enum`, which is the first
   breaking-shaped change in this area — worth batching with any other `c.*` signature change.
4. **Does `v` belong per-kind?** Entity and query facts will not evolve at the same rate, and one
   shared integer means a query-only breaking change forces entity readers to update. A
   `{ v: { entity: 1, query: 2 } }` split was considered and deferred as premature.

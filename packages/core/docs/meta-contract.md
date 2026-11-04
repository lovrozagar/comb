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

comb's payload therefore uses comb's own vocabulary — `generated`, `immutable`, `softDelete`,
`uniqueIndexes` — never oat's tag names (`x-generated`, `x-immutable`, `x-soft-delete`, `x-unique`).
Encoding the tag names
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
		"states": null,
		"tenantColumn": null,
		"uniqueIndexes": [{ "columns": ["title"], "name": "idx_post_title" }],
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

### 2.1 Field keys

Beside `x-comb` on the object, a field's own JSON Schema may carry flat `x-comb-*` keys for rules
JSON Schema cannot state. Every one sits on the property's own schema, beside the `anyOf` of a
nullable field, so a reader finds it at `properties[name]["x-comb-*"]`; an array element's rules
sit on `items` the same way. A nullable field's non-null member carries the same keys with the
same values, and no other, so a schema composed from the field with zod's `.unwrap()` (a nullable
column taken as a required input) still publishes them; a reader reads the property's and needs
no `anyOf` walk. A nullable trimmed text with a `max` of 9, as codegen publishes it on a write:

```json
{
	"anyOf": [
		{
			"type": "string",
			"maxLength": 9,
			"examples": ["string"],
			"x-comb-transform": ["trim"],
			"x-comb-text": "no U+0000 or unpaired surrogate"
		},
		{ "type": "null" }
	],
	"x-comb-transform": ["trim"],
	"x-comb-text": "no U+0000 or unpaired surrogate"
}
```

- `x-comb-transform`: the rewrites a written text takes before any check, in the order applied;
  an email's is `["trim", "lowercase"]`, a url's `["trim"]`, and `passwordText()`'s `["nfc"]`. A
  read publishes none. See §6.9 for
  what the published bounds then mean. Each value is one exact operation, which a reader in any
  language applies as written here, as its own `strip()` or `TrimSpace` differs:
  - `"trim"`: ECMAScript's `String.prototype.trim`: it removes, from both ends, these 25 code points
    of WhiteSpace and LineTerminator, and no other: U+0009–U+000D, U+0020, U+00A0, U+1680,
    U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.
  - `"lowercase"`: ECMAScript's `String.prototype.toLowerCase`: Unicode's default full case
    mapping, locale-independent, with Final_Sigma. It may change a value's length.
  - `"uppercase"`: ECMAScript's `String.prototype.toUpperCase`: the same, to upper case.
  - `"nfc"`: ECMAScript's `String.prototype.normalize("NFC")`: Unicode Normalization Form C, so a
    decomposed `e` and U+0301 become one `é`. It may shorten a value.

  Fixtures for a reader's tests, each `input` with one `transform` applied:

  ```json
  [
  	{ "transform": "trim", "input": "\ufeffann\u3000", "expect": "ann" },
  	{ "transform": "trim", "input": "\u0085ann", "expect": "\u0085ann" },
  	{ "transform": "trim", "input": "\u001cann", "expect": "\u001cann" },
  	{ "transform": "lowercase", "input": "\u0130stanbul", "expect": "i\u0307stanbul" },
  	{ "transform": "lowercase", "input": "\u03a3\u0391\u03a3", "expect": "\u03c3\u03b1\u03c2" },
  	{ "transform": "uppercase", "input": "stra\u00dfe", "expect": "STRASSE" },
  	{ "transform": "nfc", "input": "e\u0301", "expect": "\u00e9" },
  	{ "transform": "nfc", "input": "\u212b", "expect": "\u00c5" }
  ]
  ```

- `x-comb-text`: the storable-text rule: the value, after its transforms, holds no U+0000 and no
  unpaired surrogate, which no engine stores as sent. On a JSON value it binds every string in it.
- `x-comb-maxBytes`: the most UTF-8 bytes of the value's JSON text, `JSON.stringify` of the value as
  sent, quotes and escapes included: a string `ab"` is 6 bytes (`"ab\""`). A `c.json` field
  publishes it.
- `x-comb-maxUtf8Bytes`: the most UTF-8 bytes of a string value itself, after its transforms, with
  no quotes or escapes: `ab"` is 3 bytes. `passwordText({ hash: "bcrypt" })` publishes 72, the bytes
  bcrypt reads.
- `x-comb-cidr`: `true` on a Postgres cidr: the address, an IPv4 or IPv6 one with its prefix length
  or without (a host), has no bit set past that length: `10.0.0.0/8` is a network, `10.0.0.1/8` is
  not. `isCidr` from `@lovrozagar/comb` is the check.
- `x-comb-rectangular`: `true` on a multidimensional array: every sub-array of one level, across the
  whole level, has the same length, as Postgres stores an array: `[[1, 2], [3, 4]]` is one,
  `[[1, 2], [3]]` is not.
- `x-comb-minLength`, `x-comb-maxLength`, `x-comb-minimum`, `x-comb-maximum`: on a read, the
  declared bounds it states without enforcing them, so a stored row past one still reads.

## 3. Producer API

```ts
import { combMeta } from "@lovrozagar/comb/meta"

const postReadSchema = z.compile(z.object({/* … */})).meta(
	combMeta({
		kind: "entity",
		name: "post",
		identity: "id",
		generated: ["id", "created_at", "updated_at"],
		immutable: ["id", "created_at"],
		softDelete: "deleted_at",
		states: null,
		tenantColumn: null,
		uniqueIndexes: [{ columns: ["title"], name: "idx_post_title" }],
	}),
)
```

`combMeta()` returns `{ "x-comb": … }` — an object to spread into or pass to `.meta()`. It
stamps `v` itself; callers never write the version.

Two call sites inside comb produce it automatically:

| Producer                                               | Stamps                                  | Source of truth               |
| ------------------------------------------------------ | --------------------------------------- | ----------------------------- |
| `generateDtos` (`codegen/generators/dtos/generate.ts`) | `CombEntityMeta` on the **read** schema | `TableMeta` from the analyzer |
| `createListQuerySchema` (`query/list-schema.ts`)       | `CombQueryMeta` on the returned schema  | its own `config` argument     |

`createListQuerySchema` builds its stamp with `listQueryStamp` (`query/list-meta.ts`); `query/schema.ts`
only re-exports it.

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
`searchable: null` means _the producer does not know_ (§6.1); `createListQuerySchema` always knows, so it publishes a list.

## 5. Collision rules

`.meta()` in Zod 4 is a **shallow merge onto a clone**. Verified:

| Sequence                                        | Result                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| comb stamps, user adds `.meta({ description })` | both present; `x-comb` survives                                                                                  |
| comb stamps, user calls `.describe()`           | both present                                                                                                     |
| user stamps their own `x-comb` after comb       | **user wins** — last write, per key                                                                              |
| `.optional()` around a stamped object           | survives                                                                                                         |
| `.nullable()` around a stamped object           | moved under `anyOf[0]`: `readCombMeta` on the root reads null; the caller unwraps it, as it unwraps `items` (§4) |
| **`.extend()` on a stamped object**             | **`x-comb` is dropped**                                                                                          |

The last row is the trap. `.extend()` builds a new object type and does not carry the registry
entry, so a consumer who extends a generated read schema loses the entity facts **silently** —
the document simply has no `x-entity`, and oat reports a coverage gap for an entity that was
fully described one call earlier.

Mitigation, in order of preference:

1. Stamp after extending: `base.extend({ … }).meta(combMeta({ … }))`.
2. `carryCombMeta(from, to)` — re-stamps `to` with whatever `from` carries, exported for exactly
   this case. `from` is the stamped Zod schema or its JSON Schema. It returns `null`, and stamps
   nothing, when `from` carries no readable `x-comb`.

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

### 6.1 `searchable` is declared, and enforced at both ends

`createListQuerySchema({ search })` declares the fields `q` searches. Without `search` the schema
does not accept `q` at all and publishes `searchable: []`; with it, the schema accepts `q` and
publishes the list. The declaration is load-bearing at the other end too: `buildListQuery()`
throws `search_not_wired` when a request carries `q` and the handler passed no `search`
resolver, so a schema that promises search cannot silently answer with the unfiltered list.

`null` stays valid on the wire for producers that genuinely cannot know; comb's own schema
builder no longer emits it.

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

Foreign keys are immutable in comb by design, unless a column declares `{ mutable: true }` for a
reference that moves (a person's team, a category's parent), and publishing `immutable` without them would have
told a consumer that `project_id` and `author_id` are freely mutable — the fields a tenant-boundary
attack tries first. The `patch.immutable-field-rejected` check would have run, passed, and covered
nothing.

The fix is not only a longer predicate. `deriveEntityMeta` takes the field set the generator
**actually emitted** and treats whatever is missing as immutable, so the stamp describes the
update body that exists:

```ts
const updateFields = new Set(fields.filter((f) => f.type === "update").map((f) => f.key))
deriveEntityMeta(meta, updateFields)
```

The generator decides which columns enter the update body with `isExcludedFromUpdate`, which names
foreign keys and their `mutable` opt-in; `generateFieldSchema` renders a column's rules and decides
nothing about the update body. So the emitted set and the predicate give the same list. The emitted set is what
keeps the stamp right if a later rule lands in `generateFieldSchema` only. A caller with no
generator output gets the predicate: `deriveEntityMeta(table)` falls back to it, and the manifest
calls it that way (§8.2). This is the same lesson as §7, from the other direction: a fact restated
in a second place is a fact that will drift.

### 6.3 `tenantColumn` is declared, never inferred

This field is **opt-in per table**. `null` is the honest default, not a missing
annotation comb forgot to fill. A consumer that has not written `{ tenant: true }`
on any column should not expect tenancy facts from comb — that is the contract,
not a bug in 0.1.1.

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

**A tenant column is set once.** Whatever it references, a `c.ref` to the tenant table, one to a
table in another database, or a plain `c.text` or `c.integer`, it is out of the update DTO and in
`immutable`, in the stamp and the manifest alike, as §6.2 keeps an ownership key: a body that could
move it would move the row to another tenant. `{ tenant: true, mutable: true }` fails codegen,
naming the column.

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
there is no single identity to publish. `generateDtos` omits the entity stamp entirely rather than
picking one column, and `validateTables` warns that it does. The manifest lists the table with
`identity: null` and `compositePrimaryKey: true`. A composite-key entity is not addressable by a
single-id item route, so the downstream checks were not going to apply regardless.

### 6.5 `states` describes a lifecycle, not how to drive it

`null` when the table declares no machine. Otherwise the published subset of the
column's state machine: `column`, `values`, `initial`, `terminal`. `transitions`
is a write-side rule and is **not** published — a document consumer testing a
live API has no use for the graph, and publishing it would invite a consumer to
drive state by walking it. The entity manifest keeps the graph, because that
artifact is for tools that operate on the model, not for a black-box tester.

At most one machine per table. A second declaring column is warned and dropped.
See `docs/state-machines.md`.

### 6.6 `select=` is advertised only when it can be honored

The query stays fat (sort keys, id, `_total`, join keys). The response gets thin.
`createListQuerySchema({ fields })` is what puts `select` on the wire and `selectable` on
`x-comb`. Without `fields`, both are absent — so a contract tester cannot report "accepted but
ignored". `queryHelpers.paginate` / `queryHelpers.project` is what honors `parsedFields`, as the last
mutation of item shape. Do not apply `select=` in the HTTP framework: the output schema is the
full entity, and a runtime subset would fail a consumer that validates the body as that schema.

### 6.7 Query facts added within v1

`filterFields` (`{ field, type, ops }[]`), `nulls`, `maxFilterConditions`, `maxFilterDepth`,
`maxFilterValues` (bound values in all), `maxInValues`, `maxPatternBytes` (UTF-8 bytes of a `like` or `ilike` value's escaped pattern, when it has a `*` inside it: a `[` in a `like` counts as the three bytes of `[[]`, never the raw value's characters), `maxPage` (the last page offset pagination
serves), `maxSearchTerms`, `maxSortKeys`, the byte caps `maxFilterBytes` and `maxSearchBytes` (what `filter`
and `q` may take however a client encodes them, a space or a mark such as `~` counted as 3), and
`maxQueryBytes` (the whole accepted query string, 16 KB less a 2 KB path budget) were added after v1 shipped. They are optional in the type and
validated when present, so a v1 reader built before them ignores them — which is why adding them
did not bump `v`. Each value is computed from the config that parses the request, and
`tests/integration/meta/query-parity.test.ts` drives the parser to prove it.

### 6.8 Partial unique indexes are published apart

A partial unique index (`uniqueIndex().on(...).where(...)`) makes its columns unique only among
the rows its predicate matches, so it is no uniqueness of the column. comb published none before
0.15; it publishes them now as `partialUniqueIndexes: [{ columns, name, where }]`, beside
`uniqueIndexes` and never inside it. A reader built before 0.15 ignores a key it does not know: a
`where` added to an entry of `uniqueIndexes` would be dropped, and that reader would claim a global
uniqueness the index does not hold, the very harm leaving partial indexes out avoided. A field of
its own is skipped whole by such a reader, so it claims nothing. `where` is the predicate as the
index's SQL holds it: SQL over the columns' SQL names, each quoted, while `columns` lists property
names, as every other list of the stamp does. comb publishes no property-name form of the
predicate; a reader that needs one maps the SQL names through the manifest's columns. An index over a private column, or whose predicate names one, is left out,
so a private name never reaches the document. The field was added within v1: a payload without it
reads as `[]`, and one whose entry lacks `where` is malformed.

### 6.9 A written text's transforms are published, and the bounds bind their result

zod publishes no overwrite: `.trim()` and `.toLowerCase()` leave no trace in `z.toJSONSchema`, so
a client reading the spec could not learn that `"  Ann@Example.COM "` is stored as
`"ann@example.com"`, and a validator built from it disagreed with the server both ways. It
accepted `"   "` for a trimmed required text, which the server refuses, and refused `"ABC"`
under a lowercase field's `^[a-z]+$`, which the server stores as `"abc"`. comb publishes the list
as `x-comb-transform` (§2.1), written from the one list the generated zod chain is written
from, so the two cannot drift. A field's published `minLength`, `maxLength`, `pattern` and
`format` bind the transformed value: a consumer applies the listed transforms, in order, before
it checks, generates or compares a value; that is honey's and oat's half of C2 of r18, theirs to ship.

## 7. `stableTiebreak`, and a bug it surfaced

`stableTiebreak` is the column keyset pagination breaks ties on. oat calls it load-bearing:
without it, page-walk checks report phantom gaps and duplicates.

comb's SQLite cursor builder resolves it as `getTableColumns(table)["id"]` — the **JavaScript
property name** `CURSOR_TIEBREAK_COLUMN`, not the SQL column. It once returned `null` when that
lookup missed, which added no cursor predicate: the query returned the first page again, and rows
silently duplicated and went missing across pages.

`buildListQuery` now throws a `CombError` when it is asked to cursor-page a table with no `id`
property, so the failure is loud at the one place it can be exact. `stableTiebreak` is published as
the list schema's `tiebreak`, `"id"` by default, matching what `buildListQuery` does; a derived
list breaks ties on its `idColumn`, so its schema names that column (QL10 of r22b).

`validateTables()` **warns** when a table's primary-key property is not named `id`; it does not
fail. Join, config and lookup tables are never listed, and for those the property name is a free
choice that codegen has no business blocking; a composite key is exempt. Publishing the fact forced
the invariant to be stated, which is the argument for doing this at all.

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
export const postDtoReadSchema = z
	.object({
		...timestampsCreatedUpdatedDeletedReadSnakeCase,
		id: _str
			.meta({ examples: ["pst_01h5a3g8k9m2n4p6q8r0t2v4x6"] })
			.meta({ "x-comb-maxLength": 48, "x-comb-minLength": 1 }),
		status: _z_7520e2bc.meta({ examples: ["draft"] }),
		title: _str.meta(_m.string).meta({ "x-comb-maxLength": 200 }).nullable().meta({ "x-comb-maxLength": 200 }),
	})
	.meta(
		combMeta({
			generated: ["id", "created_at", "updated_at", "deleted_at"],
			identity: "id",
			immutable: ["id", "created_at", "updated_at", "deleted_at"],
			kind: "entity",
			name: "post",
			partialUniqueIndexes: [],
			softDelete: "deleted_at",
			states: null,
			tenantColumn: null,
			uniqueIndexes: [],
		}),
	)
```

This is the generated file's own text (a test reads it from the generator, so it cannot drift).
The generator hoists repeated expressions into `_shared` under names hashed from their code
(`_z_7520e2bc` is the status's rules); a read states a declared bound as `x-comb-maxLength`, on
the property itself and, as `title` is nullable, on its non-null member too (§2.1), and enforces
only what the column holds. `title` is nullable because the
column is not `.notNull()`. Every generated column is
also immutable: the update body has no key, no timestamps and no `deleted_at`. The create body
leaves out every generated column too, so a client chooses no id and backdates no row, and takes
`status` as optional, because the column has a database default.

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
          // Tag names are the consumer's. comb publishes uniqueIndexes, not x-unique.
          "x-unique": f.uniqueIndexes.length ? f.uniqueIndexes : undefined,
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

Tag names in this snippet (`x-entity`, `x-unique`, …) are the consumer's. comb publishes
`uniqueIndexes` in comb's vocabulary; honey chooses the document tag they become.

Note `searchable` is spread conditionally: `null` must become an **absent** key, not
`searchable: null`, so oat falls back to its own narrowing rather than reading an empty list as
"nothing is searchable".

**4 — what oat receives**

```yaml
x-entity: { name: post, identity: id }
x-generated: [id, created_at, updated_at, deleted_at]
x-immutable: [id, created_at, updated_at, deleted_at]
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

`internal_note` is in neither the read DTO nor any published list. `private: true`, or a name
that starts with `_`, removes a column of any kind from the read and read-partial DTOs, and
`deriveEntityMeta` leaves private columns out of `generated`, `immutable`, `states`, `tenantColumn`,
`uniqueIndexes` and `partialUniqueIndexes` (§6.8), so a private name never reaches the document. `uniqueIndexes` holds every
uniqueness the table declares: a `uniqueIndex()`, drizzle's `unique().on()` constraint, and a
column's own `.unique()` (under the name it gives, else drizzle's `<table>_<column>_unique`). Private is a read-side rule:
the create and update bodies still accept `internal_note`.

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

`tests/integration/meta/stamp-to-document.test.ts` pins comb's half: both stamps present, correct, and each
resolvable on its own schema, with the drop reproduced against a transcription of honey's own
search so the fix has a concrete case to satisfy.

## 8.2 The entity manifest

The stamp travels on a Zod schema, which is the right channel for honey and wrong for everyone
else — a Go service, a migration audit, a dashboard, anything that will not run TypeScript to
learn the shape of the database.

`comb codegen -g manifest` writes `db.<name>.manifest.gen.json` alongside the generated entities.
Per entity it carries the identity, id prefix, `softDelete`, `tenantColumn`, relations with their
referential actions, unique indexes, partial unique indexes (`partialUniqueIndexes`, each with its
`where`) and check constraints. A relation names its target in `table` by that entity's `name`, schema-qualified on Postgres as
every entity is, and its `column` and `refColumn` by their names among each entity's `columns`, so a
reader joins through the manifest alone. A composite foreign key is one relation
per column, each carrying the whole key as `key: { columns, refColumns }`, paired by position, so
a reader joins on every column together rather than on independent pairs. Per column it carries the helper that
declared it, its `sqlType`, the column's SQL type with its modifier as drizzle writes it (`timestamp(3) with time zone`, `interval day`, `numeric(3, -2)`), the bounds a write takes and enum values, `textKind` (`"email"`, `"url"`, `"imageUri"`,
`"password"`, `"name"`, or null), `transform`, the list the DTO publishes as `x-comb-transform`
(§2.1), and `generated`, `immutable` and `private` flags. `min`, `max`, `patterns` and `maxBytes`
are what the create DTO enforces, not what the column declares, from `writeRules`, which reads
the rules the DTO's builders read: a text's declared bounds with comb's own (a required text's 1, a
format's floor, an id's 1 to 48), an integer's clamped to what the column
holds on the dialect, a timestamp's to a JS number's exact range, and none on a boolean, an enum
or a timestamp comb fills. A plain Postgres column whose type has a write rule of its own (a uuid, a date, an inet, a real, a numeric with a precision) states none either: its
rule is its type's, which `kind` and `sqlType` name together, as a precision, a time zone, an interval's fields and a numeric's scale each change it, and as an inet's union of formats or a numeric's exclusive
bounds fit no `min`, `max` or pattern; a reader applies the type's own check. `patterns` lists every regex the value must match, the declared one and
the kind's own (an id's, a url's https, a name's, an image URI's), as regex literals in the order
the chain checks them; an email's own check is its format, which `textKind` names. A password
column stores the hash, so it is held to its declared bounds and pattern alone, with a required
one's 1, and `textKind: "password"` implies no rule of comb's on the plaintext. `maxBytes` is a `c.json` column's byte limit. A test holds each column's values to
the JSON Schema the create DTO publishes, on both dialects. All of them bind a value after its
`transform`, as §6.9 says of the document. Every column that declares a state machine carries it, `transitions` included. The stamp
publishes the first such column and leaves `transitions` out. Private columns are listed and
flagged rather than omitted.

It is a **projection**, not a second derivation. `identity`, `softDelete` and `tenantColumn` come
from `deriveEntityMeta`, the function the schema stamp uses, `uniqueIndexes` from
`publishedUniqueIndexes` and `partialUniqueIndexes` from `publishedPartialUniqueIndexes`, the
filters it applies, so the manifest cannot claim a fact the document contradicts — the rule §6.2
was written to enforce, applied to a second output. Each column's `generated` and `immutable` flags
come from `writesOf`, the one rule that decides which write bodies take a column, which the create
and update DTOs and the stamp's `generated` and `immutable` read too: a column comb or the database
fills (`autogenerate`, a generated or identity column, a key that `c.id`, `c.serialId`,
AUTOINCREMENT or a default fills) is in neither body, and is `generated` and `immutable`; a column a
body sets once (a key, a composite key's column, `nomutate`, a tenant, a reference not declared
`mutable`) is in the create body alone, and is `immutable`. A private column's flags state what the
bodies do, as any column's; the stamp leaves its name out of both lists, and a unique index over
one is left out of both. A table with a composite key has no stamp; its flags come from the same
rule. A test generates the DTOs, reads the stamp off the emitted read schema and holds it and the
manifest to the bodies field by field.

Entities are sorted by name and the file carries a checksum header, so regenerating an unchanged
schema is a no-op and a real change is a readable diff. `v` follows the same rule as the contract:
additive fields never bump it. `v` 2 (comb 0.19) changed what `min` and `max` mean, from declared
to enforced, and replaced `pattern` with `patterns`, so a reader of `v` 1 refuses it. `v` 3 (comb
0.21) changed what a relation's `table` means, from the target's TypeScript variable to its
entity name, so a reader of `v` 2 refuses it.

This is also the substrate for the deferred query-tap work — a committed artifact a reviewer reads
in a pull request, which is the only shape that work may take.

## 9. Tests, and why they are shaped this way

`tests/integration/meta/` holds three files:

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
In that envelope `count` is the rows the filter matches across all pages, or `null` when the
response cannot know it: cursor pages, and offset pages past the end (`paginationResponseSchema`
types it `number | null`).
Ambiguity and dedup are pinned too: two _different_ entities at one depth is an error in honey, the
_same_ entity twice is not.

That shape has already paid twice: it caught the foreign-key omission in §6.2, and it caught
`selectable` publishing relation names that the parser rejects in the bare form (`select=author`
is a 400; only `select=author(name)` parses). Both were wrong in the first implementation, and
neither would have been caught by a test that restated the rule.

## 10. Publishing: source, with declarations

comb ships its TypeScript source for runtimes and bundlers, and from 0.19 the declarations a type
checker reads. `prepack` emits them, with declaration maps, under `types/` from
`tsconfig.types.json` (which extends `tsconfig.strict.json`), and each export names them first:
`{ "types": "./types/x.d.ts", "default": "./src/x.ts" }`. Bun, `tsx`, Vite and Wrangler take
`default` and compile the source; a consumer's `tsc` takes `types` and never loads comb's `.ts`.
The order is the contract: the first condition that matches wins, and `default` always matches.

**Why.** A source-shipping package inherits the consumer's compiler settings, and `skipLibCheck`
does not help, because it only covers `.d.ts`. Up to 0.18 that meant two costs. First, every
relative specifier in comb ends in `.ts`, so a project without `allowImportingTsExtensions`
failed with TS5097: the stock create-cloudflare Worker, comb's main audience, gave 218 errors.
Second, the consumer's strict flags applied to comb's internals, which is why comb holds its
source to the union of them (below). Measured on 0.19's source with tsc 7.0.2 (plan 19, leaf
1.6; `.tmp/grunt/r20-premise/k1-*`), six packs, each in a fresh consumer:

| Pack                                  | create-cloudflare tsconfig | every subpath, bundler or nodenext | comb `.ts` tsc loads | consumer `tsc` | tarball gz, files |
| ------------------------------------- | -------------------------- | ---------------------------------- | -------------------- | -------------- | ----------------- |
| source only (0.18)                    | 218 TS5097                 | 761 TS5097                         | 279                  | 290 ms         | 582.5 KiB, 306    |
| specifiers rewritten to `.js`         | 0                          | 0                                  | 279                  | 228 ms         | 582.7 KiB, 306    |
| declarations beside the source        | 150 TS5097                 | 663 TS5097                         | 259                  | 217 ms         | 703.6 KiB, 874    |
| declarations under `types/` (shipped) | 0                          | 0                                  | 0                    | 65 ms          | 783.1 KiB, 874    |
| `.js` and declarations beside         | 0                          | 0                                  | 259                  | 224 ms         | 703.6 KiB, 874    |
| `.js` and declarations under `types/` | 0                          | 0                                  | 0                    | 62 ms          | 783.3 KiB, 874    |

Bun, `tsx`, Wrangler and Vite (with `@cloudflare/vite-plugin`, and `--ssr` with `ssr.noExternal`)
behaved the same on all six. Beside the source, a declaration's `./x.ts` or `./x.js` resolves to
the source next to it, so tsc loads it anyway. Under `types/`, the emitted `./x.ts` resolves to
the sibling `x.d.ts` under `bundler` and `nodenext`, and a `.d.ts` raises no TS5097, so no
specifier needs rewriting. The `.js` rewrite adds nothing a consumer's tsc sees once it reads
declarations, and would cost a codemod over about 2,500 specifiers and a lint rule.

**What it costs.** +200 KiB gzipped and +568 files (284 declarations, 284 maps). The maps stay:
with them, go-to-definition opens comb's source; without them, it lands in the declaration. Nothing
is committed or kept in sync by hand: `types/` is gitignored, emitted at each pack and removed by
`postpack`, and `tests/structure/api.test.ts` snapshots the same emit. `release-manifest.test.ts`
reads the tarball the release publishes, the one the consumer suite installs: each export names
its declaration first, every declaration and map ships, and every map's `sources` is inside the
package.

**Where declarations are missing.** An install that never ran `prepack` (a `file:` or link install
of the repository, a git dependency) has no `types/`. tsc then takes `default`, comb's source,
exactly as before 0.19, and a consumer cell holds that. Plain Node still refuses TypeScript under
the dependency folder (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), whatever the pack; run comb
through `tsx` or a bundler.

**Why 0.18 rejected declarations, and what changed.** It held that declarations would hide comb's
strict errors from consumers while leaving its internals loose, that every `.ts` specifier would
need rewriting, and that the bun-shebang CLI runs `.ts` directly. The first never applied:
`typecheck:strict` stays a gate, and `isolatedDeclarations`, which keeps the emit faithful to the
source, needs it. The second is measured false above. The third is unchanged, since the runtime
is still the source. The cost 0.18 feared, a pipeline across 20 exports, is one `tsc` call in
`prepack` and a condition object per export.

**The durable rule, which is the part worth sharing with honey and flare:** a package that ships
source must compile under the union of the strict flags its consumers might set, and must prove it
in CI. `bun run typecheck:strict` does that, and both workflows run it. comb's exposure turned out
to be 51 errors, all mechanical: dot access on index-signature types became bracket access, and
optional properties were widened from `p?: T` to `p?: T | undefined`. honey's is reportedly ~480,
dominated by `noUncheckedIndexedAccess`, which comb has none of. Shipping declarations then takes
the consumer's flags off the package's internals altogether; the rule still holds, because the
declarations are only as honest as the source they come from. Measure first.

**Generated files under `isolatedDeclarations`.** comb's own source compiles under it; the files
codegen writes are the app's, and only some do. Clean, each export's type annotated: constraints,
entities, enum-checks, error-keys, field-names, rows, rqb-cols, sql-cols and table-names
(`tests/integration/codegen/isolated-declarations.test.ts` holds them to it). Not clean: the DTO
entity files and `_shared`, whose zod schemas infer their types, `relations.gen.ts`
(`defineRelations`) and `orm.gen.ts`, whose types drizzle infers from the relations, and the app's
own tables module, which every generated file imports. Annotating them would emit zod's and
drizzle's internal generic types, tied to their minor versions, and buy no consumer anything while
the tables module infers. So they belong to a tsconfig without `isolatedDeclarations`: they are
imported as source, never through a d.ts. `_shared`'s example arrays are `as const`, so none of its
errors is an array's (C7 = K8 of r18).

**Export surface.** 20 entry points, down from 21 then up one for `./states`.
`./codegen/analyze` and `./migrate/drivers` were dropped as redundant —
`./codegen` and `./migrate` already re-export their contents — and `./meta` and
`./states` were added. 0.x promises nothing about these; the contract in §4 is
versioned separately from the package, precisely so the two can move at different speeds.

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
3. **Terminal-state modeling.** Implemented. `c.enum` takes an optional third argument
   (`initial` / `terminal` / `transitions`); the published subset is `CombEntityMeta.states`
   (`column`, `values`, `initial`, `terminal` — not `transitions`). See
   `docs/state-machines.md`. `successWhen` is still not derivable: comb knows which states
   are final, not which of them mean success.
4. **Does `v` belong per-kind?** Entity and query facts will not evolve at the same rate, and one
   shared integer means a query-only breaking change forces entity readers to update. A
   `{ v: { entity: 1, query: 2 } }` split was considered and deferred as premature.

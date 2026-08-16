# Column state machines — design

Status: **design, not implemented.** Written before code, per the brief.

## 1. What this is for

comb already knows a column's legal _values_ — `c.enum("status", ["draft", "sent", "failed"])`
generates a CHECK constraint from them. It does not know which of those values a row may move
_between_, or which of them are final.

That gap costs comb two things it should have on its own merits:

- **Transition validation on write.** `draft → sent` is legal, `sent → draft` is not. Today nothing
  can say so, and every app that cares re-implements the check by hand next to each update.
- **A generated state diagram.** The diagrams generator draws tables and foreign keys; it cannot
  draw the lifecycle a status column actually has.

It also happens to be the missing input for `x-async`, whose `until` / `successWhen` predicates a
consumer currently hand-writes. That is a consequence, not the design goal — see §6.

## 2. Declaration

A third argument to `c.enum`, alongside the values it already takes:

```ts
export const delivery = sqliteTable("delivery", {
	id: c.id("dlv"),
	status: c.enum("status", ["queued", "sending", "sent", "partial", "failed", "cancelled"], {
		initial: "queued",
		terminal: ["sent", "partial", "failed", "cancelled"],
		transitions: {
			queued: ["sending", "cancelled"],
			sending: ["sent", "partial", "failed"],
		},
	}),
})
```

Three facts, each independently useful:

| Key           | Meaning                                     | Optional?                                                 |
| ------------- | ------------------------------------------- | --------------------------------------------------------- |
| `initial`     | the value a row starts at                   | yes — omit when rows may be created in several states     |
| `terminal`    | values from which no transition is legal    | yes — omit when every state is reachable from every other |
| `transitions` | `from → to[]`, for non-terminal states only | yes — omit to declare only which states are final         |

The three are independent so an app can adopt the cheap half. Declaring `terminal` alone already
unlocks the downstream async work; `transitions` is the part that earns the runtime check.

**Why a third argument rather than a `states:` key in the constraint object.** The constraint
object describes _one value_ — its length, its format, whether it may be mutated. A state machine
describes relationships _between_ values. Putting it in the same bag would be the only entry there
that is not a per-value predicate, and `c.enum`'s second argument is already the value list this
would be describing, so they belong adjacent.

## 3. Validation, at generate time

`validateTables` rejects, rather than warns, on:

- a state named in `initial`, `terminal`, or a `transitions` key or target that is not in the value
  list — a typo here silently disables a rule, which is the failure mode this whole repo keeps
  finding
- a `transitions` entry whose key is listed in `terminal` — a contradiction, not a preference
- a state that is neither `initial` nor reachable through any transition, when `transitions` is
  declared in full — dead states are almost always a rename that missed a spot

It warns, and does not reject, on:

- a non-terminal state with no outgoing transitions, when `transitions` is partial. That is how an
  app declares the cheap half, so it must stay legal.

## 4. Runtime

```ts
import { assertTransition, canTransition } from "@lovrozagar/comb/states"

canTransition(deliveryStates, "queued", "sending") // true
canTransition(deliveryStates, "sent", "queued") // false — sent is terminal
assertTransition(deliveryStates, current, next) // throws CombError, 422
```

The machine is emitted by codegen as a plain object next to the enum constants, so this is a data
lookup with no dependency on the ORM and nothing to instantiate. Failure raises `CombError` with
`status: "unprocessable_entity"` and a new key `invalid_state_transition`, matching how every other
comb-detected violation surfaces.

Deliberately **not** an automatic hook on update. comb does not own the write path — a caller may
be doing a bulk correction, a backfill, or a migration where the transition rules do not apply. An
explicit call at the boundary that cares is honest; a hidden interception in the ORM would be a
rule you cannot see at the call site and cannot opt out of.

## 5. What the meta contract exposes

An additive field on `CombEntityMeta`, so **no `v` bump** (§4.1 of the meta contract):

```jsonc
"x-comb": {
  "v": 1,
  "kind": "entity",
  // …
  "states": {
    "column": "status",
    "values": ["queued", "sending", "sent", "partial", "failed", "cancelled"],
    "initial": "queued",
    "terminal": ["sent", "partial", "failed", "cancelled"]
  }
}
```

`transitions` is deliberately **not** published. It is a write-side rule; a document consumer
testing a live API has no use for the full graph, and publishing it would invite a consumer to
drive state changes by walking it — which is exactly the behaviour-derived coupling §1 of the meta
contract rules out. `values`, `initial` and `terminal` are enough to describe a lifecycle to a
reader without describing how to drive it.

`states` is `null` when the table declares no machine. At most one per table in v1: a table with two
independent lifecycles is real but rare, and `null`-or-one is a shape a consumer can read without
branching. Widening to an array later is additive on the consumer side only if they read it
defensively, so if this is likely, the field should be an array from the start — **open question,
see §7.**

## 6. What a consumer does with it, and what comb does not do

oat's `x-async` wants `until: "status.in.complete,partial,failed"` and
`successWhen: "status.eq.complete"`. Those are derivable:

- `until` — the column plus its `terminal` set
- `successWhen` — **not derivable.** comb knows which states are final. It does not know which
  of them mean _success_. `partial` is terminal; whether it counts as success is a product
  decision that lives nowhere in the schema.

comb should not add a `success:` key to close that gap. It would be a field with exactly one
consumer and one meaning, invented to complete someone else's predicate — the boundary §1 exists to
hold. The honest split: comb publishes the lifecycle, the app declares which terminal state its
contract considers success, and honey maps both onto the tag.

The predicate _syntax_ is likewise not comb's. comb publishes `terminal: ["sent", "partial"]`; the
consumer renders `status.in.sent,partial` if that is its grammar, or something else if it is not.

## 7. Open questions

1. **One machine per table, or several?** v1 says one, as `states: {…} | null`. An array is more
   future-proof but costs every consumer a loop for a case most tables never have. Deciding this
   before publishing matters, because narrowing an array to an object later _is_ a `v` bump.
2. **Does `initial` belong in the published payload?** It is genuinely useful for transition
   validation and for a diagram, and near-useless to a contract tester. Included above on the
   grounds that the payload describes the lifecycle rather than any one consumer's needs, but it is
   the weakest of the three.
3. **Should `transitions` drive the generated CHECK constraint?** Today `c.enum` generates
   `CHECK (status IN (…))`. A transition rule cannot be expressed as a column CHECK without a
   trigger, and comb does not generate triggers. Out of scope, worth stating so it is not
   rediscovered.
4. **Interaction with `softDelete`.** Is a soft-deleted row still in its declared state, or in an
   implicit terminal one? Current answer: unchanged — the tombstone is orthogonal, and conflating
   them would make `terminal` mean two things.

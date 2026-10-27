// Oxlint registers one plugin name; this entry publishes every comb rule.
import { rule as boundaries } from "./boundaries.js"
import { rule as noConsole } from "./no-console.js"
import { rule as noLocaleCompare } from "./no-locale-compare.js"
import { rule as noModuleSideEffects } from "./no-module-side-effects.js"
import { rule as noModuleState } from "./no-module-state.js"
import { rule as noSilentCatch } from "./no-silent-catch.js"
import { rule as noV8Ignore } from "./no-v8-ignore.js"
import { rule as rawSqlAllowlist } from "./raw-sql-allowlist.js"

export default {
	meta: { name: "comb" },
	rules: {
		boundaries,
		"no-console": noConsole,
		"no-locale-compare": noLocaleCompare,
		"no-module-side-effects": noModuleSideEffects,
		"no-module-state": noModuleState,
		"no-silent-catch": noSilentCatch,
		"no-v8-ignore": noV8Ignore,
		"raw-sql-allowlist": rawSqlAllowlist,
	},
}

import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-silent-catch"]
const MESSAGE = "a catch rethrows, returns or throws the converted error, calls a reporter, or says `// reason: <why>`"

const file = (body: string) => ({ "packages/core/src/migrate/core/atlas.ts": `${body}\n` })

describe("comb/no-silent-catch", () => {
	it.each([
		["a bare swallow", "try { a() } catch {}"],
		["a swallow that returns a fallback", "export function f() {\n\ttry { return a() } catch { return null }\n}"],
		["a swallow that only names the error", "try { a() } catch (e) { void e }"],
		["a reason with nothing after it", "try { a() } catch {\n\t// reason:\n}"],
		["a swallowing promise", "p.catch(() => undefined)"],
		["a promise handed a bare function", "p.catch(ignore)"],
	])("rejects %s", (_name, body) => {
		expect(reportsOf(rule, file(body))).toEqual([{ file: "packages/core/src/migrate/core/atlas.ts", message: MESSAGE }])
	})

	it.each([
		["a rethrow", "try { a() } catch (e) { throw e }"],
		["a conversion it throws", "try { a() } catch (e) { throw new CombError({ cause: e }) }"],
		["a conversion it returns", "export function f() {\n\ttry { return a() } catch (e) { return toResult(e) }\n}"],
		["a call to a reporter", "try { a() } catch (e) { log.warn({ err: e }) }"],
		["a call to an injected log", 'try { a() } catch (e) { this.log("router.revalidate.error", { error: e }) }'],
		["a reason", "try { a() } catch {\n\t// reason: the file may not exist yet; the caller creates it\n}"],
		["a promise catch that reports", "p.catch((e) => report(e))"],
		["a promise catch that rethrows", "p.catch((e) => {\n\tthrow e\n})"],
		["a promise catch with a reason", "p.catch(() => undefined) // reason: best-effort cleanup of a temp file"],
	])("accepts %s", (_name, body) => {
		expect(reportsOf(rule, file(body))).toEqual([])
	})

	it("ignores tests and code outside src", () => {
		const fixture = {
			"packages/core/src/migrate/core/atlas.test.ts": "try { a() } catch {}\n",
			"packages/core/tests/integration/support/pg.ts": "try { a() } catch {}\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the comb plugin entry", () => {
		const fixture = {
			"packages/core/src/a.ts": "try { a() } catch {}\n",
			"packages/core/src/b.ts": "try { a() } catch (e) { throw e }\n",
		}
		expect(oxlintReports("no-silent-catch", fixture)).toEqual([{ file: "packages/core/src/a.ts", message: MESSAGE }])
	})
})

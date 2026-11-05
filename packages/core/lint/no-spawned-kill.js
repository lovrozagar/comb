/* A spawned kill reaches a recorded pid as a bare process.kill does: it lands on whatever later
 * process the kernel gave the pid once the recorded one was reaped. Tests signal a recorded process
 * through tests/support/pid.ts; a shell's kill of its own `$$` names no recorded pid. */
const MESSAGE =
	"a test spawns no kill, pkill or killall of a pid: signal a recorded process through tests/support/pid.ts"

const KILLERS = new Set(["kill", "killall", "pkill"])
const SHELLS = new Set(["bash", "dash", "sh", "zsh"])
const SPAWNS = new Set(["execFile", "execFileSync", "spawn", "spawnSync"])
const EXECS = new Set(["exec", "execSync"])

function calleeName(callee) {
	if (callee.type === "Identifier") return callee.name
	if (callee.type === "MemberExpression" && callee.property.type === "Identifier") return callee.property.name
	return ""
}

/* a literal string's text, a template's with each placeholder as a word, else null */
function text(node) {
	if (node?.type === "Literal" && typeof node.value === "string") return node.value
	if (node?.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.cooked).join("X")
	return null
}

const command = (word) => KILLERS.has(word.split("/").at(-1))

/* a shell script that runs a kill of anything but its own `$$` */
function killsInScript(script) {
	return script.split(/[;&|\n]+/).some((segment) => {
		const words = segment.trim().split(/\s+/)
		return command(words[0]) && words.at(-1) !== "$$"
	})
}

/* the script a shell spawn runs: the string after `-c` in its argument array */
function shellScript(args) {
	if (args?.type !== "ArrayExpression") return null
	const at = args.elements.findIndex((element) => text(element) === "-c")
	return at === -1 ? null : text(args.elements[at + 1])
}

function spawnsKill(name, [file, args]) {
	const first = text(file)
	if (first === null) return false
	if (EXECS.has(name)) return killsInScript(first)
	if (!SPAWNS.has(name)) return false
	if (command(first)) return true
	const script = SHELLS.has(first) ? shellScript(args) : null
	return script !== null && killsInScript(script)
}

export const rule = {
	create(context) {
		return {
			CallExpression(node) {
				if (spawnsKill(calleeName(node.callee), node.arguments)) context.report({ message: MESSAGE, node })
			},
		}
	},
}

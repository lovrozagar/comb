/**
 * The CAs `sslrootcert=system` verifies a server against. libpq reads OpenSSL's
 * default store, and Atlas's driver Go's system pool. On Linux both read the same CA files, which
 * comb reads as Go does: SSL_CERT_FILE, else the first of Go's bundle files that reads, and every
 * file of SSL_CERT_DIR, else of Go's CA directories. Elsewhere Go asks the platform's verifier, which
 * comb reaches only through Node's own system store (tls.getCACertificates, Node 22.15 and later,
 * which Bun lacks); without it comb falls back to Node's bundled CAs, and its failure says so.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import tls from "node:tls"

/** Where comb's system CAs come from, said in a verification failure, and the CAs themselves; none means the runtime's bundled list */
type SystemCas = { cas: string[] | undefined; source: string }

// lookup-table: Go's CA bundle files on Linux, in its order (crypto/x509 root_linux.go)
const GO_FILES = [
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/ca-bundle.pem",
	"/etc/pki/tls/cacert.pem",
	"/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
	"/etc/ssl/cert.pem",
]
// lookup-table: Go's CA directories on Linux
const GO_DIRS = ["/etc/ssl/certs", "/etc/pki/tls/certs"]
/* one PEM certificate */
const PEM = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

/** `file`'s certificates, or none where it cannot be read */
function certsIn(file: string): string[] {
	try {
		return readFileSync(file, "utf8").match(PEM) ?? []
	} catch {
		// reason: Go skips a file it cannot read, as comb does
		return []
	}
}

/** Every certificate of `dir`'s files, or none where it cannot be listed */
function certsInDir(dir: string): string[] {
	try {
		return readdirSync(dir).flatMap((name) => certsIn(join(dir, name)))
	} catch {
		// reason: Go skips a directory it cannot read, as comb does
		return []
	}
}

/** The CA files Linux's Go reads, by `env`'s SSL_CERT_FILE and SSL_CERT_DIR */
function linuxCas(env: NodeJS.ProcessEnv): string[] {
	const file = env["SSL_CERT_FILE"]
	const files = file === undefined ? GO_FILES : [file]
	const first = files.map(certsIn).find((certs) => certs.length > 0) ?? []
	const dirs = env["SSL_CERT_DIR"]?.split(":") ?? GO_DIRS
	return [...first, ...dirs.flatMap(certsInDir)]
}

/** How a runtime reads the OS trust store */
type Store = (type: "system") => string[]

/**
 * The runtime's own reader of the OS trust store: Node's tls.getCACertificates, from Node 22.15;
 * none before it, and none on Bun, whose answers with its bundled list
 */
const runtimeStore = (
	versions: Readonly<Record<string, string | undefined>>,
	module: { getCACertificates?: Store | undefined } = tls,
): Store | null => (versions["bun"] === undefined ? (module.getCACertificates ?? null) : null)

/** The CAs sslrootcert=system verifies against on `platform`, by `env` and the runtime's `store`, and where they come from */
function systemCas(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	store: Store | null = runtimeStore(process.versions),
): SystemCas {
	if (platform === "linux")
		return {
			cas: linuxCas(env),
			source: "the system's CA files, as Atlas's driver reads them (SSL_CERT_FILE, SSL_CERT_DIR)",
		}
	if (store !== null) return { cas: store("system"), source: "the OS trust store" }
	return {
		cas: undefined,
		source: "the runtime's bundled CAs, as it reads no OS trust store here, where Atlas's driver reads the OS's",
	}
}

export { runtimeStore, type SystemCas, systemCas }

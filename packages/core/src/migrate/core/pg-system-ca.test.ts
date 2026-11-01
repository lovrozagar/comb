import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readLiveObjects } from "./pg-live-objects.ts"
import { runtimeStore, systemCas } from "./pg-system-ca.ts"
import { postgresOptionsOf } from "./pg-url.ts"

/** A stand-in PEM certificate named `name` */
const pem = (name: string) => `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----`
const dir = mkdtempSync(join(tmpdir(), "comb-system-ca-"))
const BUNDLE = join(dir, "bundle.pem")
writeFileSync(BUNDLE, `# the system's bundle\n${pem("ROOT_A")}\n${pem("ROOT_B")}\n`)
const CERTS = join(dir, "certs")
mkdirSync(CERTS)
writeFileSync(join(CERTS, "corp.pem"), `${pem("CORP_ROOT")}\n`)
writeFileSync(join(CERTS, "notes.txt"), "no certificate here\n")
const EMPTY = join(dir, "empty")
mkdirSync(EMPTY)

/** A stand-in for Node's own reader of the OS trust store */
const read = () => [pem("STORE")]

/** postgres.js's ssl for db.example with `query` */
const ssl = (query: string) => postgresOptionsOf(`postgres://db.example/app?${query}`, "url")["ssl"]

afterEach(() => vi.unstubAllEnvs())

/* R1 of 5.3's review: system means the CAs libpq and Atlas's driver verify against, never Node's bundled list on Linux */
describe.runIf(process.platform === "linux")("postgresOptionsOf: sslrootcert=system on Linux", () => {
	it("verifies against SSL_CERT_FILE and SSL_CERT_DIR's certificates, as Go and OpenSSL read them", () => {
		vi.stubEnv("SSL_CERT_FILE", BUNDLE)
		vi.stubEnv("SSL_CERT_DIR", `${CERTS}:/nonexistent`)
		const ca = [pem("ROOT_A"), pem("ROOT_B"), pem("CORP_ROOT")]
		expect(ssl("sslmode=verify-full&sslrootcert=system")).toEqual({ ca, rejectUnauthorized: true })
		expect(ssl("sslrootcert=system")).toEqual({ ca, rejectUnauthorized: true })
		expect(ssl("hostaddr=10.0.0.5&sslrootcert=system")).toEqual({
			ca,
			rejectUnauthorized: true,
			servername: "db.example",
		})
	})

	it("trusts nothing where the system has no CA, as Go does, never falling back to the bundled list", () => {
		vi.stubEnv("SSL_CERT_FILE", "/nonexistent/bundle.pem")
		vi.stubEnv("SSL_CERT_DIR", EMPTY)
		expect(ssl("sslrootcert=system")).toEqual({ ca: [], rejectUnauthorized: true })
	})
})

describe("systemCas", () => {
	it("reads Go's first bundle file and CA directories on Linux where no variable names them", () => {
		const { cas, source } = systemCas("linux", {})
		expect(cas?.length).toBeGreaterThan(0)
		expect(source).toBe("the system's CA files, as Atlas's driver reads them (SSL_CERT_FILE, SSL_CERT_DIR)")
	})

	it("reads the OS trust store through Node's own reader, never Bun's, which answers with its bundled list", () => {
		expect(runtimeStore({ node: "26.12.1" }, { getCACertificates: read })).toBe(read)
		expect(runtimeStore({ node: "22.12.0" }, {})).toBeNull()
		expect(runtimeStore({ bun: "1.4.4", node: "24.3.0" }, { getCACertificates: read })).toBeNull()
	})

	it("takes the OS trust store where the runtime reads one, and says it fell back to the bundled CAs where none", () => {
		expect(systemCas("darwin", {}, () => [pem("KEYCHAIN")])).toEqual({
			cas: [pem("KEYCHAIN")],
			source: "the OS trust store",
		})
		expect(systemCas("win32", {}, null)).toEqual({
			cas: undefined,
			source: "the runtime's bundled CAs, as it reads no OS trust store here, where Atlas's driver reads the OS's",
		})
	})
})

/* a verification failure says which CAs comb verified against, so a divergence from Atlas is named */
describe("readLiveObjects on a server sslrootcert=system cannot verify", () => {
	it("names where comb's CAs came from", async () => {
		vi.stubEnv("SSL_CERT_FILE", BUNDLE)
		vi.stubEnv("SSL_CERT_DIR", EMPTY)
		const failure = Object.assign(new Error("unable to verify the first certificate"), {
			code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		})
		const load = async () => () => ({
			end: async () => undefined,
			unsafe: async () => {
				throw failure
			},
		})
		await expect(
			readLiveObjects({ schema: "app", url: "postgres://app@db.example/app?sslrootcert=system" }, load),
		).rejects.toThrow(`unable to verify the first certificate; comb verified the server against ${systemCas().source}`)
		await expect(
			readLiveObjects(
				{ schema: "app", url: `postgres://app@db.example/app?sslmode=verify-full&sslrootcert=${BUNDLE}` },
				load,
			),
		).rejects.toThrow(/unable to verify the first certificate$/)
	})
})

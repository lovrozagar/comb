/**
 * The oldest Atlas comb runs on, pinned: `ATLAS_RANGE` (src/migrate/core/process.ts) starts at
 * v1.2.0, the oldest release the Atlas suites pass on (PA5 of r22; v1.1.0 failed 11), so a cell
 * runs comb's migrate commands on that build too. CI's test job downloads it by version and checks
 * its sha256 (.github/workflows/ci.yml, held by tests/structure/workflows.test.ts); locally the same
 * commands put it there. A missing binary or a mismatch fails the cell rather than skipping it.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** The Atlas release at the floor of `ATLAS_RANGE` */
export const ATLAS_FLOOR_VERSION = "1.2.0"

/** The sha256 of release.ariga.io's official linux-amd64 build of that release */
export const ATLAS_FLOOR_SHA256 = "c12b889e3349f0e5610aec32fe327e5a6911a0e472754a0c381c30c7c0630e88"

/** Where the binary lives: `~/.cache/comb-test/atlas/<version>/atlas` */
export const ATLAS_FLOOR_PATH = path.join(os.homedir(), ".cache/comb-test/atlas", ATLAS_FLOOR_VERSION, "atlas")

/** How to put the pinned binary in place, which a failure names */
const INSTALL = `mkdir -p ~/.cache/comb-test/atlas/${ATLAS_FLOOR_VERSION} && curl -sSfL -o ~/.cache/comb-test/atlas/${ATLAS_FLOOR_VERSION}/atlas https://release.ariga.io/atlas/atlas-linux-amd64-v${ATLAS_FLOOR_VERSION} && echo "${ATLAS_FLOOR_SHA256}  ${ATLAS_FLOOR_PATH}" | sha256sum -c - && chmod +x ~/.cache/comb-test/atlas/${ATLAS_FLOOR_VERSION}/atlas`

/** The pinned binary's path, after checking it is there and is the pinned build; throws otherwise */
export function requireAtlasFloor(file: string = ATLAS_FLOOR_PATH): string {
	if (!existsSync(file))
		throw new Error(`atlas v${ATLAS_FLOOR_VERSION} is not at ${file}: the Atlas floor cell is required; ${INSTALL}`)
	const sha = createHash("sha256").update(readFileSync(file)).digest("hex")
	if (sha !== ATLAS_FLOOR_SHA256)
		throw new Error(`${file} has sha256 ${sha}, not atlas v${ATLAS_FLOOR_VERSION}'s ${ATLAS_FLOOR_SHA256}; ${INSTALL}`)
	return file
}

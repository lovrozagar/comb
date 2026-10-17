#!/usr/bin/env bash
# Wait for an npm tarball after a publish. npm serves a version's metadata minutes before its
# tarball resolves through the CDN; v0.4.2's release failed at five minutes on a tarball that
# resolved later. So: retry the tarball for 15 minutes, then accept the release if npm lists the
# version, with a warning, and fail only when npm does not know the version at all.
#
#   npm-tarball-wait.sh <package name> <version>
#   WAIT_ATTEMPTS (default 90) and WAIT_SECONDS (default 10) pace the retries.
set -euo pipefail

name="$1"
version="$2"
attempts="${WAIT_ATTEMPTS:-90}"
seconds="${WAIT_SECONDS:-10}"
tarball="https://registry.npmjs.org/${name}/-/${name##*/}-${version}.tgz"

for i in $(seq 1 "$attempts"); do
	if curl -fsSIL "$tarball" >/dev/null 2>&1; then
		echo "npm tarball for ${name}@${version} is downloadable"
		exit 0
	fi
	echo "waiting for npm tarball (${i}/${attempts})…"
	sleep "$seconds"
done

if npm view "${name}@${version}" version >/dev/null 2>&1; then
	echo "::warning::npm lists ${name}@${version} but its tarball was not downloadable after $((attempts * seconds))s; treating it as CDN lag"
	exit 0
fi
echo "npm does not know ${name}@${version}: the publish did not land"
exit 1

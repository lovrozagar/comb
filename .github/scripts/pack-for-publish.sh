#!/usr/bin/env bash
# Pack the package as bun packs it, every catalog: and workspace: version resolved, and print the
# directory to publish. `npm publish` run in the package directory itself sends its manifest as
# written, catalog: entries and all; publishing the packed directory sends exactly the files the
# release candidate was proved on, and a directory publish carries npm provenance.
#
#   pack-for-publish.sh <package dir>   prints the packed package directory
set -euo pipefail

dir="$1"
out="$(mktemp -d)"
(cd "$dir" && bun pm pack --destination "$out" --quiet > /dev/null)
tar -xzf "$out"/*.tgz -C "$out"
if grep -Eq '"(catalog|workspace):' "$out/package/package.json"; then
	echo "the packed package.json still names a catalog: or workspace: version" >&2
	exit 1
fi
echo "$out/package"

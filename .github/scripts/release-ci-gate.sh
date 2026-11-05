#!/usr/bin/env bash
# The release's test gate: CI is the full gate, so a release reruns no test. It passes when ci.yml's push run on main
# passed at the tagged commit; scripts/ci-wait.ts does that wait, and this file adds only what ci-wait cannot know: the
# tag's commit and its version. release.yml's ci job runs it in a checkout of the tag; so can a person, in a checkout
# holding the commit, with GITHUB_REPOSITORY and GH_TOKEN set.
#
#   TAG            the release tag, v<version>; required
#   SHA            the tagged commit; empty resolves TAG through the GitHub API (a workflow_dispatch on an older tag)
#   GRACE_SECONDS  how long a commit may go without a run before it is judged never pushed to main (default 600)
#   POLL_SECONDS   the wait between polls (default 30)
set -euo pipefail

: "${TAG:?TAG is the release tag, v<version>}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is owner/repo}"
grace="${GRACE_SECONDS:-600}"
poll="${POLL_SECONDS:-30}"
api="repos/$GITHUB_REPOSITORY"
# ci-wait's gh calls name no repo; this points them at the one being released, whatever the checkout's remote.
export GH_REPO="$GITHUB_REPOSITORY"

sha="${SHA:-}"
if [ -z "$sha" ]; then
  sha="$(gh api "$api/commits/$TAG" --jq .sha)"
fi

# A commit GitHub has never seen was never pushed, so no run can come; say so now instead of after the grace.
if ! gh api "$api/commits/$sha" --jq .sha >/dev/null 2>&1; then
  echo "$sha is not on GitHub: push it to main, wait for ci.yml to pass, then tag that commit"
  exit 1
fi

# The tag names the version it publishes; a mismatch fails here, in seconds, before any wait.
version="$(gh api -H "Accept: application/vnd.github.raw" "$api/contents/packages/core/package.json?ref=$sha" | jq -r .version)"
if [ "${TAG#v}" != "$version" ]; then
  echo "tag $TAG does not match packages/core/package.json version $version at $sha"
  exit 1
fi

# ci-wait prints its own line: passed (0), failed, cancelled or never pushed (1), superseded (2).
code=0
bun "$(dirname "$0")/../../scripts/ci-wait.ts" "$sha" --grace "$grace" --poll "$poll" || code=$?
if [ "$code" -eq 2 ]; then
  echo "$TAG is on a commit whose run a newer push cancelled: tag the newer commit once its run passes"
fi
[ "$code" -eq 0 ]

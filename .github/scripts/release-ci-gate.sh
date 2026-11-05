#!/usr/bin/env bash
# The release's test gate: CI is the full gate, so a release reruns no test. It passes when ci.yml's push run on main
# passed at the tagged commit, and fails with the next command to run otherwise. release.yml's ci job runs this file,
# and so can a person, with GITHUB_REPOSITORY and GH_TOKEN set.
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

start="$SECONDS"
said=""
while :; do
  runs="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --branch main --event push --commit "$sha" --limit 20 \
    --json status,conclusion,databaseId,url,createdAt)"
  passed="$(jq -r 'map(select(.conclusion == "success"))[0].url // empty' <<<"$runs")"
  if [ -n "$passed" ]; then
    echo "ci.yml passed on main at $sha: $passed"
    exit 0
  fi
  going="$(jq -r 'map(select(.status != "completed") | .url) | join(" ")' <<<"$runs")"
  if [ -z "$going" ]; then
    last="$(jq -c 'sort_by(.createdAt) | last // empty' <<<"$runs")"
    if [ -n "$last" ]; then
      url="$(jq -r .url <<<"$last")"
      id="$(jq -r .databaseId <<<"$last")"
      if [ "$(jq -r .conclusion <<<"$last")" = "cancelled" ]; then
        created="$(jq -r .createdAt <<<"$last")"
        newer="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --branch main --event push --limit 5 \
          --json headSha,createdAt,url |
          jq -r --arg sha "$sha" --arg at "$created" 'map(select(.headSha != $sha and .createdAt > $at))[0] // empty | "\(.url) at \(.headSha)"')"
        if [ -n "$newer" ]; then
          echo "ci.yml at $sha was cancelled by a newer push ($newer): tag that commit once its run passes"
          exit 1
        fi
      fi
      echo "ci.yml did not pass on main at $sha ($url): re-run it with gh run rerun $id, then this release with gh workflow run release.yml -f tag=$TAG"
      exit 1
    fi
    if [ $((SECONDS - start)) -ge "$grace" ]; then
      echo "ci.yml has no push run on main at $sha after ${grace}s: push the commit to main before its tag"
      exit 1
    fi
    line="waiting for ci.yml's push run on main at $sha"
  else
    line="waiting on $going"
  fi
  if [ "$line" != "$said" ]; then echo "$line"; fi
  said="$line"
  sleep "$poll"
done

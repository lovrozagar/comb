<!-- Managed by ~/Development/standards (files/md/tdd.md). Edit it there, then run `bun sync.ts`. -->
# Red, fix, green

1. Red: write the test that shows the bug or the missing behavior. Run it. It must fail, for the reason the test names. Record the failing output (BUGS.md for a bug, where the repo has one).
2. Fix: the smallest change that makes it pass.
3. Green: run it again and record the passing output. Then `bun run verify`.

A test that cannot fail proves nothing. Check it: revert or break the fix, and the test must go red.

Commits: the test and the fix may share a commit or come as `test(...)` then `fix(...)`. A `fix` or `feat` commit always contains a test change.

Lint rules follow the same loop. A mistake that a rule could catch mechanically ships with a rule: a RuleTester case that fails first, then the rule, in the repo's `lint/` plugin (or `~/Development/standards` when every repo needs it).

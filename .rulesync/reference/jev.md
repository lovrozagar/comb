---
tags: [jev]
---

# Jev

Closed external decision. The source text is already saved. The question is a yes/no or a named choice. One call. Not open research. Not code. Not grunt-job.

## Availability

```
node scripts/jev.mjs --available
```

Prints `yes` or `no` and exits 0. No request. No setup line.

`no`: the session answers the question itself. Do not run the decision command. Do not mention Jev, a missing key, or setup.

`yes`: continue below.

A key is `TYPESAFE_API_KEY` or `apiKey` in `~/.grunt/jev.json` (mode 0600). Env wins. Setup, when a person asks for it: `node scripts/setup.mjs jev`. Spec: `.rulesync/reference/setup.md`.

## Decision

Write `.tmp/grunt/jev/<slug>-state.txt` (plain text or a JSON object) and `.tmp/grunt/jev/<slug>-questions.json` (the System One questions map). Put every label for that study in the one map. At most 8 questions. State at most 64000 characters.

```
node scripts/jev.mjs --state .tmp/grunt/jev/<slug>-state.txt --questions .tmp/grunt/jev/<slug>-questions.json
```

Yes/no:

```json
{ "keep": { "type": "noul", "instructions": "Does this passage promise zero retention on the default plan?" } }
```

Named choice:

```json
{
  "endpoint": {
    "type": "choice",
    "instructions": "Which endpoint should the app call?",
    "criteria": {
      "typesafe": "Vendor host, path, and key",
      "other": "A different host, path, or key"
    }
  }
}
```

Model is `jev-1.13.0`. Stdout is at most 8 lines: model, input tokens, then one label line. Exit 0. Use that label and confidence. A low confidence is the result. Do not rephrase and call again.

One request per process. UTC-day ledger `~/.grunt/jev-usage.json` stops at 40 requests or 1000000 input tokens. A 429 or 529 retries once only when `Retry-After` is at most 2 seconds.

Exit 2 means the decision call did not return a label. Answer from the sources. Do not invent a label. Do not print the key or the state.

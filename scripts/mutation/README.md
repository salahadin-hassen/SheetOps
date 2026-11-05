# SheetOps mutation harness

Checks whether the existing regression tests notice deliberate defects in
high-risk business logic. It tests a selected list of defects, so its score is
**not** a measure of complete coverage. It also proves nothing about real Google
or real n8n behaviour: the tests run offline against the simulator and a fake
Google.

```bash
node scripts/mutation/run.js                      # every mutation, about 1–2 minutes
node scripts/mutation/run.js --only=PUB-03-408-is-rejected
node scripts/mutation/run.js --out=/some/dir      # evidence location; never inside var/
node --test scripts/mutation/harness.test.js      # tests of the harness itself
```

The root `npm test` does not run the harness tests, because they live outside
`test/`.

## How a run works

1. Copies a fixed allowlist of paths to a new temporary directory outside the
   repository: `package.json`, `src`, `scripts`, `test`, `fixtures`, `workflow` and
   `docs/data-contract.md`. `frontend/`, `var/`, `.git`, `node_modules`,
   `scripts/mutation` and anything named like a credential are never copied.
2. Runs all the selected tests on an unmodified copy. If this baseline fails, no
   mutation runs: a failure could not be told apart from a kill.
3. For each mutation, one at a time: makes a fresh copy, applies the exact text
   change, checks the file still parses, rebuilds the workflow JSON in the copy,
   runs that mutation's tests, classifies the result and deletes the copy.
4. Compares a fingerprint of the source files with the one taken at the start, and
   deletes only its own temporary directory.

The workflow is rebuilt because the JSON embeds the core and glue code. Without
this, `workflow.test.js` would fail on any core change and every mutant would look
caught.

Test processes get a minimal environment (no inherited credentials or n8n settings),
network calls blocked by `net-guard.cjs`, an invalid `N8N_BIN`, and their own process
group, which is killed on timeout.

## Results

| Result | Meaning |
|---|---|
| `KILLED` | A named test matching the mutation's `expect` pattern failed |
| `SURVIVED` | Every selected test still passes |
| `INVALID` | The text was missing or not unique, so it was not applied. The source probably changed: update the mutation |
| `ERROR` | The test run proved nothing: a parse failure, a crashed test file, a timeout, or only unrelated tests failed |
| `NOT_RUN` | The baseline failed |

Mutation score = `KILLED / (KILLED + SURVIVED + ERROR)`. `INVALID` was never applied,
so it is left out. Only `KILLED` counts as caught.

Exit codes: `0` a clean baseline, unchanged source and every mutation `KILLED`; `1`
anything else; `2` the harness could not start.

## Evidence

`report.json` holds each mutation's ID, description, target file, tests, exit code,
classification, failing tests and a failure excerpt. `logs/<id>.log` holds the full
output. By default both go to a new `sheetops-mutation-evidence-*` temporary directory,
and the path is printed at the end.

## Adding a mutation

Add an entry to `mutations.js` with the exact text to change, the defect it simulates,
the test files that should catch it and an `expect` pattern for the relevant test's
name. Keep `expect` specific: a broad pattern can turn an unrelated failure into a
false kill. A survivor means a missing test or a wrong test selection. Check which
before changing anything.

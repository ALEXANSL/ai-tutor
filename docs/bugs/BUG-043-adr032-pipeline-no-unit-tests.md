# BUG-043 — ADR-032 core pipeline rewrite has zero unit-test coverage for the new state machine

**Severity:** Major (not Critical — manual code review found the logic correct; this is a missing-regression-safety-net gap, not an observed functional defect)
**Story / ADR:** ADR-032 (incremental per-section book structuring), US-2.1…2.5, NFR-RES-3

## Summary
Commit `855ac0e` ("feat(ingest): ADR-032 — incremental per-section book structuring")
rewrites the core of book indexing: `runStructure` (one AI call per book) is
split into `runStructureOutline` (pass 1) + `runStructureSection` (pass 2, one
job per section, running independently/concurrently, in any completion order)
plus a new `finalizeMaterialStatus` function that computes the book's overall
`materials.status` (`ready` / `ready_partial` / `error`) from a fresh count of
`material_sections.status` every time a section finishes, and a new
`giveUpSection`/`retrySectionAction` pair for per-section failure handling.

None of this new logic has a single automated test:
- `app/src/server/ingest/pipeline.test.ts` was **not modified** by this commit
  (confirmed via `git diff 71881c5 855ac0e --stat` — file absent from the
  changed-files list) and still only covers `errorCodeOf`,
  `isRetryableIngestError`, `skipReextraction` (pre-existing tests).
- `structure.test.ts` was updated, but only exercises the pure helpers in
  `structure.ts` (`buildOutlineSchema`, `buildSectionSchema`,
  `normalizeOutlineSections`, `normalizeSectionTopics`, `buildSectionText`) —
  none of which touch the pipeline/job-handler code in `pipeline.ts`.
- `other.test.ts` / `subjects/queries.test.ts` only cover the `status IN
  ('ready','ready_partial')` filter widening in read paths, not the write
  side.
- No test exists anywhere for: `finalizeMaterialStatus`'s status computation
  across the state space (all-ready → `ready`; some ready/some permanently
  failed → `ready_partial`; all failed → `error`; still-pending sections →
  not finalized yet), `giveUpSection`, `retrySectionAction`, or the legacy
  `ingest.structure` → `runStructureOutline` job-type alias actually
  registering and running without a "no handler" crash.

This matters more than usual here because:
1. This ADR exists specifically to fix a **real production incident**
   (`docs/adr/032-...md` §Контекст) — i.e. this is exactly the kind of
   load-bearing pipeline code that regressions in are expensive to discover
   late (a broken `finalizeMaterialStatus` would silently mis-flag books as
   `ready`/`error`/stuck-`indexing` in production, with no test catching a
   future refactor that breaks it).
2. `finalizeMaterialStatus` is explicitly designed around a concurrency
   property (recomputed fresh from the DB every time, regardless of which
   section finishes first) that is easy to accidentally break in a future
   edit (e.g. someone "optimizing" it to take an incremental counter instead
   of a fresh `SELECT` would silently reintroduce a TOCTOU race) — exactly
   the kind of property a unit test should pin down with a
   multi-section-finishing-out-of-order test case.
3. `retrySectionAction`'s "never touches sibling sections" guarantee and the
   legacy-job-alias "never crashes on old queued jobs" guarantee are both
   safety properties explicitly promised by the ADR text, with real
   currently-queued production jobs depending on the latter (confirmed via
   Alex's diagnostic SQL this session) — yet neither has a regression test.

## Evidence
```
$ git diff 71881c5 855ac0e --stat
 app/prompts/indexing_outline.md                    |  43 +++
 app/prompts/indexing_structure.md                  |  48 ++-
 app/src/app/actions/books.ts                       |  21 ++
 app/src/app/parent/books/[id]/page.tsx             |  16 +-
 app/src/components/parent/books/BooksList.tsx      |  14 +-
 app/src/i18n/uk.ts                                 |  13 +
 app/src/server/books/queries.ts                    |  12 +-
 app/src/server/ingest/pipeline.ts                  | 347 ++++++++++++++++-----   <- no matching pipeline.test.ts change
 app/src/server/ingest/structure.test.ts            | 127 +++++---
 app/src/server/ingest/structure.ts                 | 118 ++++---
 app/src/server/materials/other.test.ts             |  28 +-
 app/src/server/materials/other.ts                  |  14 +-
 app/src/server/subjects/queries.test.ts            |   6 +-
 app/src/server/subjects/queries.ts                 |  13 +-
 docs/STATUS.md                                     |  24 ++
 .../20261009100000_adr032_incremental_structure.sql | 161 ++++++++++
```
`pipeline.ts` gained 347 lines of diff (new job handlers, new state-machine
function, new retry path) with **zero** corresponding lines in
`pipeline.test.ts`.

## Expected
Given the codebase's own established pattern (every other pipeline concern —
`errorCodeOf`, `isRetryableIngestError`, `skipReextraction` — has a direct
unit test in `pipeline.test.ts`, and `structure.ts`'s pure helpers are
thoroughly tested), `finalizeMaterialStatus`, `runStructureOutline`,
`runStructureSection`, `giveUpSection`, and `retrySectionAction` should have
the same direct coverage, in particular:
- `finalizeMaterialStatus`: table-driven test over the section-status state
  space (empty, all-ready, mixed ready/error, all-error, still-pending) →
  asserts the resulting `materials.status`/`status_detail`.
- A test that calls `finalizeMaterialStatus` twice concurrently (or twice in
  sequence simulating two sections finishing near-simultaneously) and asserts
  the result is stable/correct either way.
- `retrySectionAction`: asserts it only mutates the targeted section row and
  enqueues only that section's job (no query/update touching other
  `material_sections` rows for the same material).
- A test that calls the registered `ingest.structure` (legacy) job handler
  and asserts it runs `runStructureOutline` successfully instead of throwing
  "no handler".

## Actual
No such tests exist. The behavior was verified correct in this review only
by manual reading of `pipeline.ts`, `structure.ts`, and the migration SQL —
there is no CI/regression protection against a future change silently
breaking any of these properties.

## Fix task for `developer`
Add unit tests to `app/src/server/ingest/pipeline.test.ts` (or a new
`pipeline.structure-adr032.test.ts` if that's a better fit next to the
existing file) covering, at minimum, the four cases listed under "Expected"
above. Mock the Supabase-like `scope` the same way `other.test.ts` /
`subjects/queries.test.ts` already do for their table calls. This is a
pre-merge-quality gap, not a functional defect — the current implementation
passed manual review — but should be closed before this pipeline sees
further changes, given it exists specifically to fix a real prod incident.

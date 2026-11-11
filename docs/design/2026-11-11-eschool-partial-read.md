# Partial school-diary reads: feedback and diagnostics

The owner successfully ran the bookmarklet on desktop and imported 68 records (34 appointments and 34 homework items). The supplied packet validates against the current contract and contains text for all homework items, but 20 additional detail reads failed. The old collector discarded the error category; the actual cause cannot be inferred from that packet. Original imported data and completion statuses must remain intact.

## Changes

- Match the public diary client’s detail request: `GET Homework/{id}?embed=File`. This is compatibility, not proof that the parameter caused the failures.
- Preserve schedule values when optional detail fields are absent/null.
- Export only allowlisted error categories (HTTP status, timeout, network, response shape); never response bodies, credentials or arbitrary exception strings.
- Stop scheduling more detail requests after HTTP 429 or overall deadline exhaustion. Already-started reads may finish; no automatic retry loop.
- Keep partial packets importable and mark them incomplete. Explain that schedule text was retained and detail/attachment completeness needs comparison with the original.
- Collapse warnings into an accessible bounded list in the parent import screen; old packets remain supported.

## Validation

Regression fixtures cover detail embed, null fields, 429/503, timeout, network failures, mismatched homework IDs, no secret transfer and bounded requests after throttling. Browser fixtures exercise old warning wording and partial-data preview. No real school session, cookies or paid AI calls are used. The next user-side read is needed to identify the actual live failure category.

Validation completed: 2136 full unit tests before the final body-read classification refinement; 11 final focused collector cases, TypeScript, production build, lint (0 errors / 8 existing warnings), client bundle 126 files / 0 leaks. Chromium partial-read/clipboard/preview/import flow passed at 320/390/768/1440 in both themes with synthetic data.

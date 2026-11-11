# Diary-to-subject navigation focus

Opening a subject from the school diary should keep the full lesson catalogue while selecting and scrolling to the relevant lesson.

The link carries only the school-record UUID. The server reads that record scoped to the authenticated family and child, verifies its bound subject, and searches only topics already eligible for the child catalogue (including the existing Studio-extension exclusion).

Selection precedence: existing explicit topic binding; unique normalized title ignoring paragraph prefixes/punctuation; one explicit paragraph number with one eligible matching title. Duplicate names, duplicate paragraph numbers, ranges/multiple references and exercise numbers are not guessed. A missing explicit bound topic is not silently replaced. Inferred focus is navigation-only and is never saved as an assignment binding or progress update. No AI calls.

The selected card gets a visible diary badge, ring, aria-current and an automatic instant scroll after mount; a new request UUID retriggers scrolling. Existing last-visited highlighting remains outside diary navigation and is suppressed inside it to avoid two contradictory selections. Unknown matches retain the catalogue with an explanatory banner and diary return link.

Validation covers matching/ambiguity, record ownership/subject isolation, invalid query IDs, page wiring, last-visited coexistence and actual browser navigation/scrolling to card 38 of 40 at 320/390/768/1440 in both themes. Browser requests and catalogues are synthetic; no private diary session or paid AI calls.

Completed checks: 2153 unit tests / 189 files; TypeScript; lint 0 errors / 8 existing warnings; production build; 8 Chromium viewport/theme scenarios.

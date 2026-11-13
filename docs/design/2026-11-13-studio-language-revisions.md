# Workshop: language lessons, photographed pages, imported-lesson revisions

## Audit

- StudioCreate accepts only TXT/MD/text PDFs and directs scans elsewhere; source action rejects image-only PDFs.
- Studio author explicitly forces Ukrainian narration; publication hardcodes uk-UA and V3 narration does not consume content_tts.lang.
- /parent/materials duplicates the Workshop entry, exposes four legacy importers, while subject pages separately link import, Studio, and video scripts.
- Existing Studio revisions only operate on Studio projects. Imported lessons have no parent instruction modal or reviewed replacement workflow.

## Intended result

One Workshop entry with catalogue/create, ZIP + universal prompt, video, books/source uploads. Old links redirect to the relevant Workshop section; remove legacy import forms from primary UI without deleting data or parsers. Books and media catalogues remain management libraries, not competing course generators.

English/German course setting: Ukrainian instruction and explanations; original spelling, exercise numbering and original-language example audio. Explicit optional narration language per block; default legacy Ukrainian. Separate original-language listening examples from Ukrainian explanations where useful. No Cyrillic phonetic substitutions.

A photo or a short scanned PDF is recognised only after an explicit paid OCR button. Retain original text/task numbering; parent reviews/edits recognition before lesson creation. No permanent original image upload. Use configured OCR route and existing family budget; no automatic retries. Textbook is optional.

Parent lesson catalogue selects one or several existing lessons and opens a prompt dialog. Each selected lesson gets its own durable Studio revision draft, review and explicit publication. Load available lesson content plus parsed books. Inadequate original content is not treated as complete source evidence. Do not fabricate missing literary excerpts or biographies.

Replacement is a reversible overlay: retain the imported original and its IDs/progress, publish the reviewed revision under a separate Studio version and resolve the original link to the active version. Hide derivative topics from the main subject list. Disabling the revision restores the original link; allow reading the original explicitly. Preserve normal extensions as optional supplements. Existing direct reader and tutor contexts must resolve consistently. Multiple drafts do not modify the live lesson before publication.

## Validation and limits

Cover owner isolation, OCR media/page/size limits and unreadable results, old schema compatibility, language metadata/cache isolation, no implicit publication, batch partial success/idempotency, reader/tutor routing and reversible replacements. Use synthetic sources and model mocks locally; no real paid OCR/TTS calls or private family data without their supplied material. No schema migration or original data deletion.

## Concrete implementation

- Existing materials and add-book URLs redirect to Workshop tabs. Book upload UI lives in the Workshop; source and audio libraries retain catalogue/management roles with clearer sidebar labels. Legacy parsers/APIs remain for compatibility; legacy multi-file forms are removed from the primary page.
- Photos up to 15 MB are reduced in-browser when needed (max edge 2800 / JPEG 0.85, upload under 3 MB); short scanned PDFs up to 3 pages / 3 MB. OCR explicit-only through configured ocr_page route, max output 5000 and timeout <=90s, shared family budget. OCR is separate from the Studio project cap. Recognised text is retained for copying if the combined-source limit is exceeded.
- One deterministic family/subject/topic revision project avoids multiple competing active replacements. Per-operation UUID guards retries. An existing active/plan-stage draft is reopened rather than silently scheduling another paid task; the UI explicitly says when no new task was started. Up to six selections are submitted independently with partial success/status links; there is no all-or-nothing batch transaction.
- Replacements use a separate Studio package. Original reader URLs redirect only to visible reviewed replacements; original=1 explicitly shows the original without looping. Navigation keeps the original subject order and video topic, hidden derivative topics are not duplicated, and diary homework resolves the published replacement. Metadata lookup failures fall back to the readable original.
- Source book originals and old lesson rows/progress are not deleted. New version steps have their own progress, rather than copying answers into semantically different questions. Studio's existing multi-table publication is not presented as a new atomic SQL transaction.

[Pedagogical self-review](../pedagogy-reviews/2026-11-13-language-photo-lessons.md).

Completed validation: 2203 full unit tests, final focused source/workspace checks, TypeScript, lint 0 errors / 8 existing warnings, production build, bundle 127 files / 0 leaks, and eight browser viewport/theme scenarios plus real browser large-image preparation. Original fallback, source ownership, language metadata/cache, no silent source truncation and operation deduplication are covered.

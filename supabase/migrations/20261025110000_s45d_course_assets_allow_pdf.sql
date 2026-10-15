-- =============================================================================
-- Fix: real-import warning "mime type application/pdf is not supported" for
-- all 46 `assets/lessons/L0NN.pdf` (lesson_pdf) files in the S45 (literature
-- v2.0.0, "Українська література") package. `course_assets` (S34) only
-- allowed webp/png/jpeg, widened for SVG in S35
-- (`20261018100000_s35_course_assets_allow_svg.sql`) — S45 is the first
-- package to upload a PDF into this bucket (one per lesson, for the
-- "virtual book" reader), so the allowlist needs to widen again, not the
-- upload code (which already sends `application/pdf`).
--
-- Safe to re-run in the Supabase SQL Editor.
-- =============================================================================

update storage.buckets
set allowed_mime_types = array['image/webp', 'image/png', 'image/jpeg', 'image/svg+xml', 'application/pdf']
where id = 'course_assets';

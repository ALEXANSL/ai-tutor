-- =============================================================================
-- Fix: real-import error "mime type image/svg+xml is not supported" when
-- importing the S35 math course package's 8 blank construction-template
-- figures (`ray_193_blank.svg` etc. — PO-flagged as NOT decorative, the
-- actual printable templates for construction exercises). `course_assets`
-- (migration `20261016100000_s34_course_import.sql`) only allowed
-- webp/png/jpeg, since S34 never had any vector figures. S35 reuses the same
-- bucket (see that migration's own header) and does have SVGs, so the
-- bucket's allowlist needs to widen, not the upload code (which already
-- sends the correct `image/svg+xml` content type).
--
-- Safe to re-run in the Supabase SQL Editor.
-- =============================================================================

update storage.buckets
set allowed_mime_types = array['image/webp', 'image/png', 'image/jpeg', 'image/svg+xml']
where id = 'course_assets';

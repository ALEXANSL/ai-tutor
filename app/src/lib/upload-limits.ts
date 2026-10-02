/**
 * Shared with both the client (`UploadBookButton`, instant feedback) and the
 * server (`server/drive/upload.ts`, the limit that actually matters) so the
 * two never drift apart (ADR-024 §6). Plain constant, no secrets — safe in
 * the client bundle.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * S34: the course-package zip goes to Supabase Storage (not Drive), whose
 * `course_import_staging` bucket's own `file_size_limit` (migration
 * 20261016100000) is the real ceiling — this constant mirrors it for
 * instant client-side feedback, same pattern as `MAX_UPLOAD_BYTES` above.
 */
export const MAX_COURSE_ZIP_BYTES = 300 * 1024 * 1024;

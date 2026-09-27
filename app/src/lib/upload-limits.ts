/**
 * Shared with both the client (`UploadBookButton`, instant feedback) and the
 * server (`server/drive/upload.ts`, the limit that actually matters) so the
 * two never drift apart (ADR-024 §6). Plain constant, no secrets — safe in
 * the client bundle.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

"use client";
import { StudioSourceUpload } from "@/components/parent/studio/StudioSourceUpload";
/** Legacy library entry point uses the same uploader, processing status and source preview as Studio. */
export function UploadBookButton({ enabled }: { enabled: boolean }) {
  return <StudioSourceUpload enabled={enabled} />;
}

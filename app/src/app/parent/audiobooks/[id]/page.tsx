import { notFound } from "next/navigation";
import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { readAudioPart } from "@/server/audiobooks/store";
import { kickAudioPart } from "@/server/audiobooks/wake";
import { audioRunning } from "@/lib/audiobooks";
import { AudioPreparation } from "@/components/library/AudioPreparation";
export const maxDuration = 300;
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { familyId } = await requireParentAccess(); const { id } = await params; if (!z.string().uuid().safeParse(id).success) notFound();
  const part = await readAudioPart(familyId, id); if (!part) notFound(); if (audioRunning(part)) kickAudioPart(familyId, id);
  return <div className="mx-auto max-w-4xl"><AudioPreparation id={id} initial={part} /></div>;
}

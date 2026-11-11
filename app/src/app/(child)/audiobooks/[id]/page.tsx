import { LibraryReturn } from "@/components/library/LibraryReturn";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireLessonAccess } from "@/server/auth/guards";
import { listAudioCards, readAudioPart } from "@/server/audiobooks/store";
import { AudiobookPlayer } from "@/components/library/AudiobookPlayer";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { familyId } = await requireLessonAccess(); const { id } = await params; if (!z.string().uuid().safeParse(id).success) notFound();
  const part = await readAudioPart(familyId, id); if (!part || !part.published || part.state !== "ready") notFound();
  const next = (await listAudioCards(familyId, part.request.materialId, true)).filter(c => c.from > part.sourceTo).sort((a, b) => a.from - b.from)[0];
  return <main className="mx-auto max-w-3xl space-y-6 px-4 pb-32 pt-20"><LibraryReturn /><Link href={`/library/${part.request.materialId}`} className="inline-flex min-h-11 items-center font-bold text-primary">← До книги</Link><header><h1 className="text-2xl font-extrabold">{part.request.title}</h1><p className="mt-2 text-muted">{part.bookTitle}{part.author ? ` · ${part.author}` : ""}</p></header><AudiobookPlayer id={id} segments={part.segments.map(s => ({ text: s.text, ready: s.ready }))} />{next && <Link href={`/audiobooks/${next.id}`} className="inline-flex min-h-12 items-center rounded-xl border border-line px-4 font-bold text-primary">Наступна готова частина: {next.title} →</Link>}</main>;
}

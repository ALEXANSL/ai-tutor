import Link from "next/link";
import { VideoLibrary } from "@/components/parent/videos/VideoLibrary";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily, getFamilyTimezone } from "@/server/db/family-scope";
import { listVideoLibrary } from "@/server/lessons/videoLessons";
import { PageTitle } from "../ui";

export default async function VideoLibraryPage({ searchParams }: { searchParams: Promise<{ subject?: string }> }) {
  const { subject } = await searchParams;
  const { familyId } = await requireParentAccess();
  const [videos, timeZone] = await Promise.all([listVideoLibrary(familyId).catch(() => null), getFamilyTimezone(forFamily(familyId))]);
  return <div className="mx-auto max-w-6xl"><PageTitle action={<Link href="/parent/materials?tab=video" className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-sm font-bold text-white">Додати відео</Link>}>Відеотека</PageTitle><p className="mb-6 max-w-2xl text-sm leading-relaxed text-p-muted">Усі завантажені відео до предметів і курсів. Заміна або видалення відео не змінює текстовий урок.</p>{videos ? <VideoLibrary videos={videos} timeZone={timeZone} initialSubjectId={subject} /> : <p role="alert" className="rounded-2xl border border-p-line bg-p-surface p-5 text-sm">Не вдалося завантажити відеотеку. Онови сторінку, щоб спробувати ще раз.</p>}</div>;
}

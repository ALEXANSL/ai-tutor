import { studioDiagnosticFromHistory } from "@/server/studio/provider-history";
import { studioParentView } from "@/lib/studio-parent-view";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentAccess } from "@/server/auth/guards";
import { readStudioProject } from "@/server/studio/store";
import { StudioProject } from "@/components/parent/studio/StudioProject";
import { studioProjectDecks } from "@/server/studio/decks";
export const maxDuration = 300;
export default async function StudioProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { familyId } = await requireParentAccess(); const { id } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) notFound(); const project = await readStudioProject(familyId, id); if (!project) notFound();
  const decks = await studioProjectDecks(familyId, id, project);
  const waiting = project.request.narratedDeck && !project.publication;
  return <div className="mx-auto max-w-4xl"><Link href="/parent/studio" className="mb-4 inline-flex min-h-11 items-center text-sm font-bold text-p-primary">← Усі проєкти майстерні</Link>
    {(decks.length > 0 || waiting) && <section aria-label="Презентації з озвучкою" className="mb-5 rounded-2xl border border-p-line bg-p-surface p-4"><h2 className="text-base font-bold">Презентації з озвучкою</h2>
      {waiting ? <p className="mt-1 text-sm text-p-muted">Підготуються автоматично після того, як ти опублікуєш уроки.</p>
        : <ul className="mt-2 space-y-1">{decks.map(deck => <li key={deck.id}><Link href={`/parent/studio/presentations/${deck.id}`} className="inline-flex min-h-11 items-center text-sm font-bold text-p-primary">{deck.title} · {deck.label}</Link></li>)}</ul>}
    </section>}
    <StudioProject id={id} initial={studioParentView(await studioDiagnosticFromHistory(familyId, id, project))} startEditing={(await searchParams).edit === "1"} /></div>;
}

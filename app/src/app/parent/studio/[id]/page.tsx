import { studioParentView } from "@/lib/studio-parent-view";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentAccess } from "@/server/auth/guards";
import { readStudioProject } from "@/server/studio/store";
import { StudioProject } from "@/components/parent/studio/StudioProject";
export const maxDuration = 300;
export default async function StudioProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { familyId } = await requireParentAccess(); const { id } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) notFound(); const project = await readStudioProject(familyId, id); if (!project) notFound();
  return <div className="mx-auto max-w-4xl"><Link href="/parent/studio" className="mb-4 inline-flex min-h-11 items-center text-sm font-bold text-p-primary">← Усі проєкти майстерні</Link><StudioProject id={id} initial={studioParentView(project)} startEditing={(await searchParams).edit === "1"} /></div>;
}

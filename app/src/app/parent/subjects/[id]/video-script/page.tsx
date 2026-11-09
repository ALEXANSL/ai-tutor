import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { loadVideoLessonSource, VideoSourceError } from "@/server/video-script/source";
import { readVideoDraft } from "@/server/video-script/service";
import { VideoScriptEditor } from "@/components/parent/subjects/VideoScriptEditor";
import { PageTitle, Panel } from "../../../ui";

export const maxDuration = 180;
export default async function VideoScriptPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ topic?: string }> }) {
  const { familyId } = await requireParentAccess();
  const { id } = await params;
  const { topic } = await searchParams;
  if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(topic).success) notFound();
  let source;
  try { source = await loadVideoLessonSource(familyId, id, topic!); }
  catch (error) {
    if (!(error instanceof VideoSourceError)) throw error;
    return <><PageTitle>Сценарій Pictory</PageTitle><Panel title="Підготовка матеріалу"><p>{error.message}</p><Link href={`/parent/subjects/${id}`} className="mt-4 inline-block text-p-primary">До уроків предмета</Link></Panel></>;
  }
  const draft = await readVideoDraft(familyId, id, topic!).catch(() => null);
  return <>
    <PageTitle><Link href={`/parent/subjects/${id}`} className="mb-1 block text-[13px] font-normal text-p-primary">← До уроків предмета</Link>Сценарій Pictory</PageTitle>
    <Panel title={source.title}><p className="mb-4 text-sm text-p-muted">{source.subject} · Текстових блоків: {source.blocks.length}. Сценарій готує OpenAI за матеріалами цього уроку.</p>
      <VideoScriptEditor subjectId={id} topicId={topic!} sourceHash={source.hash} initialDraft={draft} />
    </Panel>
  </>;
}

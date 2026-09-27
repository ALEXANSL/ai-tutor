import { notFound } from "next/navigation";
import { MaterialReadScreen } from "@/components/child/MaterialReadScreen";
import { requireChild } from "@/server/auth/guards";
import { listMaterialChatMessages } from "@/server/lessons/materialChat";
import { getOtherMaterialDetail } from "@/server/materials/other";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * US-23.1 КП-3/КП-4 (E-23): opening one "Інше" material — sequential
 * reading of its already-indexed text plus a chat scoped to it. 404s the
 * same way `/subject/[id]` does when the material no longer meets the
 * "Інше" visibility criterion (removed, linked to a topic/course since, or
 * toggled off) — КП-2/КП-6.
 */
export default async function ChildMaterialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { ctx, profile } = await requireChild();
  const detail = await getOtherMaterialDetail(ctx.familyId, id);
  if (!detail) notFound();

  const materialTitle = detail.title ?? detail.name;
  const { messages } = await listMaterialChatMessages(ctx.familyId, profile.id, detail.id);

  return (
    <MaterialReadScreen
      materialId={detail.id}
      materialTitle={materialTitle}
      chunks={detail.chunks}
      initialMessages={messages}
      partiallyIndexed={detail.partiallyIndexed}
    />
  );
}

import { redirect } from "next/navigation";
import { requireParentAccess } from "@/server/auth/guards";
/** Compatibility entry: the import forms now have one home in Studio. */
export default async function MaterialsImportPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireParentAccess(); const { tab } = await searchParams;
  redirect(`/parent/studio?tab=${tab === "video" || tab === "book" || tab === "materials" ? tab : "course"}`);
}

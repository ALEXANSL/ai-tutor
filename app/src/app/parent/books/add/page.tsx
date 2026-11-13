import { redirect } from "next/navigation";
import { requireParentAccess } from "@/server/auth/guards";
/** Keep existing dashboard/bookmark links while providing one upload form. */
export default async function AddBookPage() {
  await requireParentAccess(); redirect("/parent/studio?tab=book");
}

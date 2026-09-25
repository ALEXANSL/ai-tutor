import { NextResponse } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { getDriveFolderUrl } from "@/server/drive/service";

/**
 * "Відкрити папку в Google Drive" (US-2.7 KP-4): the folder link is built on
 * the server from the env variable, only for the parent role, and is never
 * rendered into a page or logged (NFR-PRIV-8).
 */
export async function GET(request: Request) {
  const { familyId } = await requireParentAccess();
  const url = await getDriveFolderUrl(familyId);
  const target = url ?? new URL("/parent/books/add", request.url).toString();
  const res = NextResponse.redirect(target, 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

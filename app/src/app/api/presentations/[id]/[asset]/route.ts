import { NextResponse } from "next/server";
import { z } from "zod";
import { accessibleDeck } from "@/server/decks/access";
import { pdfPath, pptxPath } from "@/server/decks/store";
import { createServiceClient } from "@/server/supabase/clients";
import { signedAudioUrl } from "@/server/audiobooks/storage";
import { audioHash } from "@/server/audiobooks/text";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; asset: string }> }) {
  const { id, asset } = await params;
  if (!z.string().uuid().safeParse(id).success) return new Response(null, { status: 404 });
  const result = await accessibleDeck(id, new URL(req.url).searchParams.get("preview") === "1");
  if (!result) return new Response(null, { status: 404 });
  const { deck, familyId } = result;
  let url: string;
  if (asset === "slides.pdf" || (asset === "lesson.pptx" && deck.generated?.pptxReady)) {
    const signed = await createServiceClient().storage.from("course_assets").createSignedUrl(asset === "lesson.pptx" ? pptxPath(familyId, id) : pdfPath(familyId, id), 120, asset === "lesson.pptx" ? { download: deck.title + ".pptx" } : undefined);
    if (!signed.data) return new Response(null, { status: 503 });
    url = signed.data.signedUrl;
  } else {
    const n = /^([1-9]\d*)\.mp3$/.exec(asset);
    const slide = n ? deck.slides[Number(n[1]) - 1] : undefined;
    if (!slide?.ready) return new Response(null, { status: 404 });
    url = await signedAudioUrl(familyId, id, audioHash(slide.narration));
  }
  return NextResponse.redirect(url, { status: 307, headers: { "Cache-Control": "private, no-store" } });
}

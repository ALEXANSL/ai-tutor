import { PPTX_BUCKET } from "@/server/decks/pptx-storage";
import { NextResponse } from "next/server";
import { z } from "zod";
import { accessibleDeck } from "@/server/decks/access";
import { pdfPath, pptxPath } from "@/server/decks/store";
import { createServiceClient } from "@/server/supabase/clients";
import { signedAudioUrl } from "@/server/audiobooks/storage";
import { audioHash } from "@/server/audiobooks/text";
import { signedVideoUrl } from "@/server/decks/video";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; asset: string }> }) {
  const { id, asset } = await params;
  if (!z.string().uuid().safeParse(id).success) return new Response(null, { status: 404 });
  const result = await accessibleDeck(id, new URL(req.url).searchParams.get("preview") === "1");
  if (!result) return new Response(null, { status: 404 });
  const { deck, familyId } = result;
  let url: string;
  if (asset === "lesson.mp4") {
    if (deck.video?.state !== "ready") return new Response(null, { status: 404 });
    url = await signedVideoUrl(familyId, id, deck.title).catch(() => "");
    if (!url) return new Response(null, { status: 503 });
  } else if (asset === "slides.pdf" || (asset === "lesson.pptx" && deck.generated?.pptxReady)) {
    const bucket = asset === "lesson.pptx" && deck.generated?.pptxBucket === PPTX_BUCKET ? PPTX_BUCKET : "course_assets";
    const signed = await createServiceClient().storage.from(bucket).createSignedUrl(asset === "lesson.pptx" ? pptxPath(familyId, id) : pdfPath(familyId, id), 120, asset === "lesson.pptx" ? { download: deck.title + ".pptx" } : undefined);
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

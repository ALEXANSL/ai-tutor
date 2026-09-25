import Link from "next/link";
import { notFound } from "next/navigation";
import { ChildCard, ghostButton } from "@/components/child/ChildCard";
import { uk } from "@/i18n/uk";
import { requireChild } from "@/server/auth/guards";
import { createUserClient } from "@/server/supabase/clients";

/** Stub subjects (US-3.4): a static "coming soon" screen, no AI calls. */
export default async function SoonPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  await requireChild();
  const supabase = await createUserClient();
  const { data: subject } = await supabase
    .from("subjects")
    .select("name_uk, is_stub, config")
    .eq("code", code)
    .maybeSingle<{ name_uk: string; is_stub: boolean; config: { icon?: string } }>();
  if (!subject?.is_stub) notFound();
  const t = uk.child.soon;
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <ChildCard>
        <div className="mb-3 text-5xl" aria-hidden="true">
          {subject.config.icon ?? "✨"}
        </div>
        <h1 className="mb-3 text-2xl font-extrabold">{subject.name_uk}</h1>
        <p className="mb-6 text-lg">{t.creative}</p>
        <Link href="/today" className={ghostButton}>
          {t.back}
        </Link>
      </ChildCard>
    </main>
  );
}

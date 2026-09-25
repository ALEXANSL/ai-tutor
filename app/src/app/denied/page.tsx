import Link from "next/link";
import { ChildCard, ghostButton } from "@/components/child/ChildCard";
import { uk } from "@/i18n/uk";

/** US-1.2 KP-2: the child's account cannot open the cabinet, also by direct URL. */
export default function DeniedPage() {
  const t = uk.denied;
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <ChildCard>
        <div className="mb-3 text-5xl" aria-hidden="true">
          🔒
        </div>
        <h1 className="mb-3 text-2xl font-extrabold">{t.title}</h1>
        <p className="mb-6 text-muted">{t.body}</p>
        <Link href="/today" className={ghostButton}>
          {t.back}
        </Link>
      </ChildCard>
    </main>
  );
}

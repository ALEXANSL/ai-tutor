import { ChildCard, ghostButton } from "@/components/child/ChildCard";
import { uk } from "@/i18n/uk";

/** US-1.1 KP-2: "Цей акаунт не має доступу", no data shown. */
export default function NoAccessPage() {
  const t = uk.noAccess;
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <ChildCard>
        <h1 className="mb-3 text-2xl font-extrabold">{t.title}</h1>
        <p className="mb-6 text-muted">{t.body}</p>
        <form action="/auth/signout" method="post">
          <button type="submit" className={ghostButton}>
            {t.signOut}
          </button>
        </form>
      </ChildCard>
    </main>
  );
}

import { redirect } from "next/navigation";
import { ChildCard } from "@/components/child/ChildCard";
import { TutorAvatar } from "@/components/TutorAvatar";
import { uk } from "@/i18n/uk";
import { getSessionContext } from "@/server/auth/session";
import { missingRequiredEnv } from "@/server/env";

type Search = Promise<{ error?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const { error } = await searchParams;
  const ctx = await getSessionContext();
  if (ctx.kind === "user") redirect("/");
  if (ctx.kind === "forbidden") redirect("/no-access");
  const t = uk.login;
  const missing = missingRequiredEnv();
  const configError = error === "config" || ctx.kind === "not_configured";

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <ChildCard>
        <div className="mb-4">
          <TutorAvatar state="listening" badge={false} />
        </div>
        <h1 className="mb-2 text-[26px] font-extrabold">{t.title}</h1>
        <p className="mb-6 text-base leading-relaxed text-muted">{t.subtitle}</p>

        {error === "no_access" && (
          <div role="alert" className="mb-5 rounded-2xl bg-surface-alt p-4 text-left">
            <b className="block text-danger">{t.errors.no_access}</b>
            <span className="text-sm text-muted">{t.errors.no_access_hint}</span>
          </div>
        )}
        {error === "auth" && (
          <p role="alert" className="mb-5 font-bold text-danger">
            {t.errors.auth}
          </p>
        )}
        {configError && (
          <div role="alert" className="mb-5 rounded-2xl bg-surface-alt p-4 text-left text-sm">
            <b className="block text-danger">{t.errors.config}</b>
            {/* Variable NAMES only — never values. */}
            {missing.length > 0 && <code className="mt-1 block break-words text-muted">{missing.join(", ")}</code>}
          </div>
        )}

        <form action="/auth/login" method="post">
          <button
            type="submit"
            className="inline-flex min-h-14 w-full items-center justify-center gap-2.5 rounded-[18px] border border-line bg-white px-5 py-4 text-lg font-bold text-[#3c4043]"
          >
            <span className="font-black text-[#4285F4]" aria-hidden="true">
              G
            </span>
            {t.button}
          </button>
        </form>
        <p className="mt-4 text-sm text-muted">{t.hint}</p>
      </ChildCard>
    </main>
  );
}

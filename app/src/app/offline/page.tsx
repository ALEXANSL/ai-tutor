import { uk } from "@/i18n/uk";

/** Precached by the service worker; shown instead of a browser error (NFR-RES-4). */
export const dynamic = "force-static";

export default function OfflinePage() {
  const t = uk.offline;
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-[520px] rounded-[28px] bg-surface p-8 text-center">
        <div className="mb-3 text-5xl" aria-hidden="true">
          ☁️
        </div>
        <h1 className="mb-3 text-2xl font-extrabold">{t.title}</h1>
        <p className="mb-6 text-muted">{t.body}</p>
        {/* Full reload on purpose: client-side navigation needs the network. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="inline-flex min-h-14 w-full items-center justify-center rounded-[18px] bg-primary px-5 text-lg font-bold text-white">
          {t.retry}
        </a>
      </div>
    </main>
  );
}

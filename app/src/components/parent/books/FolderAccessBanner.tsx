import { recheckFolderAccessAction } from "@/app/actions/books";
import { uk } from "@/i18n/uk";
import type { StoredFolderAccess } from "@/server/drive/service";

/**
 * Prominent warning while the Drive folder is open to "anyone with the link"
 * (US-2.1 KP-2, R-8) — on the dashboard and in "Мої книги". Not only colour:
 * icon + text (docs/04 §1.4).
 */
export function FolderAccessBanner({ status }: { status: StoredFolderAccess }) {
  const t = uk.parent.books.access;
  const { access } = status;
  if (access.state === "restricted") return null;
  if (access.state === "unknown" && access.reason === "not_configured") return null;
  const isPublic = access.state === "public";
  return (
    <div
      role="alert"
      className="mb-4 flex gap-2.5 rounded-xl border border-p-warn bg-p-warn/15 px-4 py-3.5 text-[13px] text-p-text"
    >
      <span aria-hidden="true">⚠️</span>
      <div className="flex-1">
        <b className="mb-0.5 block">
          {isPublic ? t.publicTitle(t.levels[access.level] ?? t.levels.unknown!) : t.unknownTitle}
        </b>
        {isPublic ? (
          <>
            <p>{t.publicBody}</p>
            <ol className="mt-1 list-decimal pl-5">
              {t.howTo.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </>
        ) : (
          <p>{t.unknownBody}</p>
        )}
        <form action={recheckFolderAccessAction} className="mt-2">
          <button type="submit" className="min-h-11 font-bold text-p-primary">
            {t.recheck}
          </button>
        </form>
      </div>
    </div>
  );
}

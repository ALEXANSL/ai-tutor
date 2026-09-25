import { uk } from "@/i18n/uk";
import { CheckFolderButton } from "./CheckFolderButton";

/**
 * Quick action "Додати книгу" (US-2.7 KP-4, PM-20): (1) open the Drive folder —
 * the link is resolved on the server by /parent/books/drive, it never appears in
 * the page; (2) hint; (3) "Я додав — перевірити папку".
 */
export function AddBookPanel({ driveConfigured }: { driveConfigured: boolean }) {
  const t = uk.parent.books.add;
  return (
    <section id="addBook" className="mb-4 rounded-2xl border border-p-line bg-p-surface px-5 py-4.5">
      <h2 className="mb-1 text-[15px] font-semibold">{t.title}</h2>
      <p className="mb-3.5 text-xs text-p-muted">{t.steps}</p>
      <ol className="flex flex-col gap-3">
        <li>
          {driveConfigured ? (
            <a
              href="/parent/books/drive"
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-12 items-center justify-center rounded-2xl border-2 border-dashed border-p-line px-4 text-center text-[14px] font-bold text-p-primary hover:border-p-primary"
            >
              {t.openDrive}
            </a>
          ) : (
            <p className="text-[13px] text-p-muted">{t.driveMissing}</p>
          )}
        </li>
        <li className="text-[13px] text-p-muted">💡 {t.hint}</li>
        <li>
          <CheckFolderButton />
        </li>
      </ol>
    </section>
  );
}

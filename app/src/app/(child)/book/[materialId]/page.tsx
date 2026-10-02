import { notFound } from "next/navigation";
import { BookReader } from "@/components/child/BookReader";
import { uk } from "@/i18n/uk";
import { requireChild } from "@/server/auth/guards";
import { getBookMaterialMeta } from "@/server/books/reader";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PDF reader (Alex, 2026-10-02, verbatim: "читалка книги в pdf форматі...
 * з пошуком по сторінках, за номером завдання/параграфу/задачі, і
 * текстовий пошук"). Shows the real PDF (illustrations, original layout)
 * client-side — `literature/book/[materialId]` stayed a plain topic list on
 * purpose (earlier this week); this is the actual reader the PO asked for.
 * No AI call anywhere in this route or its API routes.
 */
export default async function ChildBookReaderPage({ params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params;
  if (!UUID.test(materialId)) notFound();
  const { ctx } = await requireChild();

  const meta = await getBookMaterialMeta(ctx.familyId, materialId);
  if (!meta) notFound();

  const title = meta.title ?? meta.name;
  if (meta.format !== "pdf") {
    return (
      <main className="px-6 pt-4">
        <h1 className="mb-4 text-2xl font-extrabold">{title}</h1>
        <p className="text-sm text-muted">{uk.child.book.notPdf}</p>
      </main>
    );
  }

  return <BookReader materialId={meta.id} title={title} initialPageCount={meta.pageCount} />;
}

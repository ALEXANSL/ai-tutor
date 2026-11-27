import Link from "next/link";
import { SectionTabs } from "@/components/parent/SectionTabs";
import { MaterialCatalog } from "@/components/parent/catalog/MaterialCatalog";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily, getFamilyTimezone } from "@/server/db/family-scope";
import { loadCatalog } from "@/server/catalog/catalog";
import { parseCatalogFilters } from "@/lib/catalog";
import { PageTitle } from "../ui";
export const maxDuration = 60;

/** D-142: every material of the family in one place, with search, filters and an archive. */
export default async function CatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { familyId } = await requireParentAccess();
  const raw = await searchParams;
  const filters = parseCatalogFilters({ get: name => { const value = raw[name]; return typeof value === "string" ? value : null; } });
  const [items, timeZone] = await Promise.all([loadCatalog(familyId).catch(() => null), getFamilyTimezone(forFamily(familyId))]);
  return <div className="mx-auto max-w-6xl">
    <SectionTabs section="library" />
    <PageTitle action={<Link href="/parent/studio/new" className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-sm font-bold text-white">Підготувати урок із ШІ</Link>}>Усі матеріали</PageTitle>
    <p className="mb-5 max-w-2xl text-sm leading-relaxed text-p-muted">Уроки, презентації з озвучкою, відео, аудіо й книги в одному каталозі. Архів ховає матеріал лише з цього списку: нічого не видаляється, а дитина бачить усе як раніше.</p>
    {items ? <MaterialCatalog items={items} initialFilters={filters} timeZone={timeZone} /> : <div role="alert" className="rounded-2xl border border-p-line bg-p-surface p-5 text-sm">Не вдалося завантажити каталог. <Link href="/parent/catalog" className="font-bold text-p-primary underline">Оновити сторінку</Link></div>}
  </div>;
}

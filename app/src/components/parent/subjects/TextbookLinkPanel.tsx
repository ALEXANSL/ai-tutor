"use client";

import { useState } from "react";
import { linkPackageTextbookAction } from "@/app/actions/content-admin";
import { withBusySignal } from "@/lib/busy-signal";
import { uk } from "@/i18n/uk";

export interface SubjectPackageRow {
  kind: "course_v2" | "literature_v2";
  id: string;
  title: string;
  textbookMaterialId: string | null;
  maxPrintedPageTo: number | null;
}

export interface SubjectPdfOption {
  id: string;
  title: string;
  pageCount: number | null;
}

/**
 * US-29.2: replaces the hand-run `UPDATE course_v2_packages/literature_v2_packages
 * SET textbook_material_id = '<uuid>'` with a plain dropdown of the
 * subject's already-uploaded PDFs (КП-1) — applies to the whole package at
 * once (КП-2) and warns, without blocking, when the chosen PDF is shorter
 * than the package's own largest referenced page (КП-3).
 */
export function TextbookLinkPanel({ packages, pdfOptions }: { packages: SubjectPackageRow[]; pdfOptions: SubjectPdfOption[] }) {
  const t = uk.parent.contentAdmin.textbook;
  const [state, setState] = useState(() => new Map(packages.map((p) => [p.id, p.textbookMaterialId ?? ""])));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, { kind: "ok" | "warn" | "error"; message: string }>>({});

  if (packages.length === 0) return null;
  if (pdfOptions.length === 0) return <p className="text-[13px] text-p-muted">{t.empty}</p>;

  async function save(pkg: SubjectPackageRow) {
    const materialId = state.get(pkg.id) || null;
    setBusyId(pkg.id);
    setNotices((prev) => ({ ...prev, [pkg.id]: undefined as unknown as { kind: "ok" | "warn" | "error"; message: string } }));
    const result = await withBusySignal(() => linkPackageTextbookAction(pkg.kind, pkg.id, materialId));
    setBusyId(null);
    if (result.status === "error") {
      setNotices((prev) => ({ ...prev, [pkg.id]: { kind: "error", message: result.message } }));
      return;
    }
    setNotices((prev) => ({ ...prev, [pkg.id]: result.pageWarning ? { kind: "warn", message: t.pageWarning } : { kind: "ok", message: t.saved } }));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-p-muted">{t.hint}</p>
      {packages.map((pkg) => {
        const notice = notices[pkg.id];
        return (
          <div key={pkg.id} className="flex flex-col gap-2 rounded-xl border border-p-line p-3">
            <span className="text-[13.5px] font-bold">{pkg.title}</span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={state.get(pkg.id) ?? ""}
                onChange={(e) => setState((prev) => new Map(prev).set(pkg.id, e.target.value))}
                className="min-h-11 flex-1 rounded-xl border border-p-line bg-p-bg px-3 text-[13.5px]"
              >
                <option value="">{t.noPdfOption}</option>
                {pdfOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                    {m.pageCount ? ` (${m.pageCount} с.)` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => save(pkg)}
                disabled={busyId === pkg.id}
                className="min-h-11 shrink-0 rounded-xl bg-p-primary px-4 text-[13.5px] font-bold text-white disabled:cursor-not-allowed disabled:bg-p-line disabled:text-p-muted"
              >
                {t.save}
              </button>
            </div>
            {notice && (
              <p className={`text-[12.5px] font-bold ${notice.kind === "error" ? "text-p-danger" : notice.kind === "warn" ? "text-p-warn" : "text-p-success"}`}>{notice.message}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

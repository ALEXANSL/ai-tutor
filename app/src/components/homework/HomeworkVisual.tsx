import type { HomeworkTable, HomeworkVisual as Visual } from "@/lib/homework";
import { homeworkVisualSvg } from "@/lib/homework-visual";
export function HomeworkVisual({ visual }: { visual: Visual }) {
  return <figure className="my-4 rounded-xl border border-line bg-white p-3 text-slate-900"><div className="overflow-x-auto [&_svg]:h-auto [&_svg]:min-w-[700px] [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: homeworkVisualSvg(visual) }} /><figcaption className="mt-2 text-sm">{visual.caption}</figcaption><ul className="mt-2 space-y-1 text-sm">{visual.items.filter(item => item.detail).map((item, index) => <li key={index}><strong>{item.label}:</strong> {item.detail}</li>)}</ul></figure>;
}
export function HomeworkDataTable({ table }: { table: HomeworkTable }) {
  return <div className="my-4 min-w-0 overflow-x-auto rounded-xl border border-line"><table className="w-full border-collapse text-left text-sm"><caption className="p-3 text-left font-bold">{table.title}</caption><thead className="bg-surface-alt"><tr>{table.columns.map((column, index) => <th key={index} className="border-b border-line p-3">{column}</th>)}</tr></thead><tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="border-b border-line p-3 align-top">{cell}</td>)}</tr>)}</tbody></table></div>;
}

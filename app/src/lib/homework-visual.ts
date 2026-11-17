import type { HomeworkVisual } from "./homework";
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
function lines(value: string, width: number) {
  const result: string[] = []; let line = "";
  const words = value.split(/\s+/).flatMap(word => word.length <= width ? [word] : word.match(new RegExp(`.{1,${width}}`, "gu")) ?? [word]);
  for (const word of words) { if (line.length + word.length > width && line) { result.push(line); line = ""; } line += `${line ? " " : ""}${word}`; }
  if (line) result.push(line); return result;
}
function text(value: string, x: number, y: number, width: number, size = 24, color = "#17243d") {
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans,Arial,sans-serif" font-size="${size}" fill="${color}">${lines(value, width).map((line, i) => `<tspan x="${x}" dy="${i ? size * 1.3 : 0}">${escape(line)}</tspan>`).join("")}</text>`;
}
/** Validated labels only: no model-generated SVG, scripts, URLs or arbitrary coordinates. Details remain in native text/notes. */
export function homeworkVisualSvg(visual: HomeworkVisual): string {
  const colors = ["#1d4ed8", "#0f766e", "#7c3aed", "#b45309", "#be185d"];
  let body = `<rect width="1000" height="450" rx="24" fill="#f8fafc"/>${text(visual.title, 30, 43, 62, 28)}`;
  if (visual.kind === "chart" && visual.items.every(item => item.value !== null)) {
    const min = Math.min(0, ...visual.items.map(item => item.value!)), max = Math.max(0, ...visual.items.map(item => item.value!));
    const range = Math.max(1, max - min), zero = 350 + (0 - min) / range * 560;
    body += `<path d="M${zero} 110V430" stroke="#64748b" stroke-width="2"/>`;
    for (const [i, item] of visual.items.entries()) {
      const y = 120 + i * 62, value = 350 + (item.value! - min) / range * 560;
      body += text(item.label, 30, y + 17, 28, 18);
      body += `<rect x="${Math.min(value, zero)}" y="${y + 24}" width="${Math.abs(value - zero)}" height="22" rx="5" fill="${colors[i]}"/>${text(`${item.value} ${visual.unit}`, 360, y + 15, 45, 18)}`;
    }
  } else {
    const width = 920 / visual.items.length;
    for (const [i, item] of visual.items.entries()) {
      const x = 30 + i * width, color = colors[i]!;
      body += `<rect x="${x}" y="140" width="${width - 20}" height="215" rx="16" fill="#ffffff" stroke="${color}" stroke-width="3"/><circle cx="${x + 30}" cy="168" r="17" fill="${color}"/>${text(String(i + 1), x + 24, 175, 3, 19, "#ffffff")}`;
      body += text(item.label, x + 14, 215, Math.floor((width - 45) / 11), 20, color);
      if (["sequence", "timeline"].includes(visual.kind) && i < visual.items.length - 1) body += `<path d="M${x + width - 18} 250h16m-7 -7l7 7-7 7" fill="none" stroke="${color}" stroke-width="3"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 450" width="1000" height="450" role="img" aria-label="${escape(visual.title)}"><title>${escape(visual.title)}</title>${body}</svg>`;
}

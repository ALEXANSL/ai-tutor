import type { StudioVisual } from "@/lib/studio";
const xml = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").replace(/[<>&"']/g, value => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[value]!);
function lines(text: string, limit: number): string[] {
  const result: string[] = []; let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > limit && line) { result.push(line); line = ""; }
    if (word.length > limit) { if (line) { result.push(line); line = ""; } for (let i = 0; i < word.length; i += limit) result.push(word.slice(i, i + limit)); }
    else line = `${line} ${word}`.trim();
  }
  if (line) result.push(line); return result;
}
export function studioVisualSvg(visual: StudioVisual): string {
  const text = (value: string, x: number, y: number, size = 17, limit = 65) => lines(value, limit).map((line, i) => `<text x="${x}" y="${y + i * (size + 4)}" font-family="Arial,sans-serif" font-size="${size}" fill="#1d1f24">${xml(line)}</text>`).join("");
  const title = text(visual.title, 28, 40, 22, 48);
  const titleHeight = lines(visual.title, 48).length * 26;
  let body = "";
  const figureTop = titleHeight + 70;
  if (visual.kind === "dimensions" && visual.width && visual.height) {
    const ratio = Math.min(400 / visual.width, 170 / visual.height);
    const width = visual.width * ratio, height = visual.height * ratio;
    body += `<rect x="75" y="${figureTop}" width="${width}" height="${height}" fill="#e8f0ff" stroke="#2f6fed" stroke-width="3"/>`;
    body += text(`${visual.width} ${visual.unit}`, 75 + width / 2 - 25, figureTop - 10);
    body += text(`${visual.height} ${visual.unit}`, 85 + width, figureTop + 10 + height / 2);
  }
  const start = titleHeight + (visual.kind === "dimensions" ? 285 : 45);
  for (const [index, item] of visual.items.entries()) {
    const y = start + index * 95;
    body += `<rect x="25" y="${y}" rx="10" width="650" height="80" fill="#edf4ff" stroke="#b9cff7"/>`;
    body += text(`${index + 1}. ${item.label}`, 40, y + 24, 18, 60) + text(item.detail, 40, y + 47, 14, 75);
    if (index < visual.items.length - 1) body += `<path d="M350 ${y + 80} v15" stroke="#2f6fed" stroke-width="2"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${xml(visual.title)}" viewBox="0 0 700 ${start + visual.items.length * 95 + 20}"><rect width="100%" height="100%" fill="#fff"/>${title}${body}</svg>`;
}

/** Public equivalent of a diagram, readable on small screens and available to the lesson tutor. */
export function studioVisualDescription(visual: StudioVisual): string {
  return `${visual.title}. ${visual.kind === "dimensions" && visual.width && visual.height ? `Розміри: ${visual.width} × ${visual.height} ${visual.unit}. ` : ""}${visual.items.map(item => `${item.label}: ${item.detail}`).join("; ")}`;
}

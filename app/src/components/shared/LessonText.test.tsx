import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonText, lessonTextBlocks } from "./LessonText";

describe("safe lesson text formatting", () => {
  it("formats source structure while preserving nonsequential printed numbers", () => {
    const html = renderToStaticMarkup(<LessonText text={"# Порівнюємо\n\n**Зверни увагу:** на одиниці.\n\n3. Знайди радіус\n7. Порівняй значення\n\n- Перевір обчислення\n- Поясни висновок"} />);
    expect(html).toContain("<h4>");
    expect(html).toContain("<strong>");
    expect(html).toContain('<li value="3">');
    expect(html).toContain('<li value="7">');
    expect(html).toContain("<ul>");
    expect(html).not.toContain("**Зверни");
  });

  it("never turns source HTML or links into executable markup", () => {
    const html = renderToStaticMarkup(<LessonText text={'<script>alert("x")</script>\n\n[сайт](javascript:alert(1))'} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<a ");
  });

  it("keeps multiline display math intact across blank lines and renders it as math", () => {
    const text = "Обчисли:\n$$\n\\frac{1}{2}\n\n+ \\frac{1}{3}\n$$\n\nПоясни результат.";
    const blocks = lessonTextBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "Обчисли:\n$$\n\\frac{1}{2}\n\n+ \\frac{1}{3}\n$$" });
    expect(renderToStaticMarkup(<LessonText text={text} />)).toContain('class="katex"');
  });

  it("preserves poem lines and literal list-like markers in reading mode", () => {
    const text = "# Це рядок твору\n1. І це авторська нумерація\n\n  Другий рядок зі зсувом";
    const html = renderToStaticMarkup(<LessonText text={text} preserveLines />);
    expect(html).toContain("lesson-prose--reading");
    expect(html).toContain("# Це рядок твору\n1. І це авторська нумерація\n\n  Другий рядок зі зсувом");
    expect(html).not.toContain("<h4");
    expect(html).not.toContain("<ol");
  });

  it("does not interpret emphasis markers inside a complete formula", () => {
    const blocks = lessonTextBlocks("**Площа:** $a^2$\n\n$$a ** b$$");
    expect(blocks).toHaveLength(2);
    const html = renderToStaticMarkup(<LessonText text={"**Площа:** $a^2$\n\n$$a ** b$$"} />);
    expect(html.match(/<strong>/g)).toHaveLength(1);
  });
});

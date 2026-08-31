import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

function render(markdown: string): Element {
  const { document } = parseHTML("<html><body></body></html>");
  const doc = document as unknown as Document;
  const host = doc.createElement("div");
  host.append(renderMarkdown(markdown, doc));
  return host;
}

describe("renderMarkdown", () => {
  it("renders bullet lists with inline formatting", () => {
    const host = render("- First **key** point\n- Second point with `code`\n");
    const items = host.querySelectorAll("ul > li");
    expect(items).toHaveLength(2);
    expect(items[0]?.querySelector("strong")?.textContent).toBe("key");
    expect(items[1]?.querySelector("code")?.textContent).toBe("code");
    expect(host.textContent).toContain("First key point");
  });

  it("renders ordered lists", () => {
    const host = render("1. one\n2. two\n3. three\n");
    expect(host.querySelectorAll("ol > li")).toHaveLength(3);
  });

  it("renders headings shifted below the panel's own heading levels", () => {
    const host = render("# Top\n## Sub\n\nBody *text*.");
    expect(host.querySelector("h3")?.textContent).toBe("Top");
    expect(host.querySelector("h4")?.textContent).toBe("Sub");
    expect(host.querySelector("p em")?.textContent).toBe("text");
  });

  it("joins consecutive lines into one paragraph and splits on blanks", () => {
    const host = render("line one\nline two\n\nsecond paragraph");
    const paragraphs = host.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe("line one line two");
  });

  it("renders pipe tables with inline formatting in cells", () => {
    const host = render("| Plan | **Price** |\n| --- | :---: |\n| Free | $0 |\n| Pro | $10 |\n");
    const headers = host.querySelectorAll("thead th");
    expect(headers).toHaveLength(2);
    expect(headers[1]?.querySelector("strong")?.textContent).toBe("Price");
    const rows = host.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.querySelectorAll("td")[1]?.textContent).toBe("$10");
    expect(host.querySelector(".table-wrap")).not.toBeNull();
  });

  it("pads ragged body rows to the header width", () => {
    const host = render("| A | B | C |\n| --- | --- | --- |\n| only | two |\n");
    expect(host.querySelectorAll("tbody td")).toHaveLength(3);
  });

  it("treats escaped pipes as cell content, not delimiters", () => {
    const host = render("| `a \\| b` | union |\n| --- | --- |\n| x \\| y | z |\n");
    const headers = host.querySelectorAll("thead th");
    expect(headers).toHaveLength(2);
    expect(headers[0]?.querySelector("code")?.textContent).toBe("a | b");
    expect(headers[1]?.textContent).toBe("union");
    const cells = host.querySelectorAll("tbody td");
    expect(cells[0]?.textContent).toBe("x | y");
    expect(cells[1]?.textContent).toBe("z");
  });

  it("does not absorb prose whose only pipe is escaped into a table body", () => {
    const host = render("| A | B |\n| --- | --- |\n| 1 | 2 |\nplain \\| prose");
    expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(host.querySelector("p")?.textContent).toContain("plain");
  });

  it("requires the separator row to match the header width", () => {
    const host = render("| A | B |\n| --- |\n| 1 | 2 |");
    expect(host.querySelector("table")).toBeNull();
  });

  it("leaves pipe text without a separator row as a paragraph", () => {
    const host = render("either | or\nmore prose");
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector("p")?.textContent).toBe("either | or more prose");
  });

  it("keeps a streaming table prefix as a paragraph until the separator arrives", () => {
    const partial = render("| Plan | Price |");
    expect(partial.querySelector("table")).toBeNull();
    const complete = render("| Plan | Price |\n| --- | --- |\n| Free | $0 |");
    expect(complete.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("starts a table even when it follows a paragraph with no blank line", () => {
    const host = render("Intro sentence.\n| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(host.querySelector("p")?.textContent).toBe("Intro sentence.");
    expect(host.querySelectorAll("tbody td")).toHaveLength(2);
  });

  it("never interprets HTML in model output", () => {
    const host = render('<img src=x onerror=alert(1)> and <b>bold</b>');
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("b")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

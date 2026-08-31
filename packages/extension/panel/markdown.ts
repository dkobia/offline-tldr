// Minimal Markdown-to-DOM renderer for model output. Covers what summary
// prompts ask for (headings, lists, tables, bold/italic, inline code) and
// builds real DOM nodes via textContent, so model output is never parsed as
// HTML.

const INLINE_PATTERN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;

export function renderMarkdown(markdown: string, doc: Document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const lines = markdown.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = (lines[index] ?? "").trim();

    if (line.length === 0) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      // Model headings start at h3 in the panel so they sit under the page title.
      const level = Math.min(heading[1].length + 2, 6);
      const element = doc.createElement(`h${level}`);
      appendInline(element, heading[2], doc);
      fragment.append(element);
      index += 1;
      continue;
    }

    const header = parseTableRow(line);
    if (header && startsTable(line, (lines[index + 1] ?? "").trim())) {
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const row = parseTableRow((lines[index] ?? "").trim());
        if (!row) {
          break;
        }
        rows.push(row);
        index += 1;
      }
      fragment.append(buildTable(header, rows, doc));
      continue;
    }

    if (parseListItem(line)) {
      const ordered = /^\d/.test(line);
      const list = doc.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = parseListItem((lines[index] ?? "").trim());
        if (!item || /^\d/.test((lines[index] ?? "").trim()) !== ordered) {
          break;
        }
        const li = doc.createElement("li");
        appendInline(li, item, doc);
        list.append(li);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    // Paragraph: consume consecutive non-blank, non-structural lines.
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = (lines[index] ?? "").trim();
      if (
        next.length === 0 ||
        parseListItem(next) ||
        /^#{1,6}\s/.test(next) ||
        startsTable(next, (lines[index + 1] ?? "").trim())
      ) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    const p = doc.createElement("p");
    appendInline(p, paragraph.join(" "), doc);
    fragment.append(p);
  }

  return fragment;
}

// GFM pipe-table row: at least one pipe, cells trimmed, outer pipes optional,
// "\|" is literal cell content rather than a delimiter.
function parseTableRow(line: string): string[] | null {
  if (!line.includes("|")) {
    return null;
  }
  const cells: string[] = [];
  let cell = "";
  let closedByPipe = false;
  let sawDelimiter = line.startsWith("|");
  for (let index = sawDelimiter ? 1 : 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && line[index + 1] === "|") {
      cell += "|";
      index += 1;
      closedByPipe = false;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      closedByPipe = true;
      sawDelimiter = true;
    } else {
      cell += char;
      closedByPipe = false;
    }
  }
  // A line whose only pipes are escaped ("plain \| prose") is not a row.
  if (!sawDelimiter) {
    return null;
  }
  if (!closedByPipe || cell.trim().length > 0) {
    cells.push(cell.trim());
  }
  return cells;
}

// A header row only becomes a table when the next line is a separator row of
// the same width (per GFM), so a mid-stream table prefix, prose containing
// "|", or a malformed separator stays a paragraph.
function startsTable(line: string, nextLine: string): boolean {
  const header = parseTableRow(line);
  if (!header) {
    return false;
  }
  const separator = parseTableRow(nextLine);
  return (
    separator !== null &&
    separator.length === header.length &&
    separator.every((cell) => /^:?-+:?$/.test(cell))
  );
}

function buildTable(header: string[], rows: string[][], doc: Document): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.className = "table-wrap";
  const table = doc.createElement("table");
  wrap.append(table);

  const thead = doc.createElement("thead");
  const headRow = doc.createElement("tr");
  for (const cell of header) {
    const th = doc.createElement("th");
    appendInline(th, cell, doc);
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = doc.createElement("tbody");
  for (const row of rows) {
    const tr = doc.createElement("tr");
    // Ragged rows are padded/truncated to the header width.
    for (let column = 0; column < header.length; column += 1) {
      const td = doc.createElement("td");
      appendInline(td, row[column] ?? "", doc);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);

  return wrap;
}

function parseListItem(line: string): string | null {
  const match = /^(?:[-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
  return match?.[1] ?? null;
}

function appendInline(parent: Element, text: string, doc: Document): void {
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index;
    if (start > last) {
      parent.append(doc.createTextNode(text.slice(last, start)));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      const code = doc.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("**")) {
      const strong = doc.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else {
      const em = doc.createElement("em");
      em.textContent = token.slice(1, -1);
      parent.append(em);
    }
    last = start + token.length;
  }
  if (last < text.length) {
    parent.append(doc.createTextNode(text.slice(last)));
  }
}

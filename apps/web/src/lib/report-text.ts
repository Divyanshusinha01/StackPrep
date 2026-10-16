export type ReportTextBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; language: string; code: string };

export type InlineSegment = { kind: "text"; text: string } | { kind: "code"; text: string };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Splits AI-written answer text into paragraphs, simple lists and fenced code blocks. Everything
 * is returned as plain text for React to escape; no HTML is ever produced. An unclosed fence runs
 * to the end of the text so code is never rendered as prose.
 */
export function parseReportText(input: string): ReportTextBlock[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReportTextBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
    if (list) {
      blocks.push({ kind: "list", ...list });
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) {
        code.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: "code", language: fence[2]!.toLowerCase(), code: code.join("\n").replace(/\s+$/, "") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null;
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) {
        flush();
      }
      list ??= { ordered, items: [] };
      list.items.push(item[1]!);
      continue;
    }
    if (list) {
      flush();
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Splits a line of prose on single-backtick code spans. */
export function parseInlineCode(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const pattern = /`([^`\n]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) {
      segments.push({ kind: "text", text: text.slice(last, match.index) });
    }
    segments.push({ kind: "code", text: match[1]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ kind: "text", text: text.slice(last) });
  }
  return segments;
}

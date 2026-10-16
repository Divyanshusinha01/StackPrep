import { describe, expect, it } from "vitest";
import { parseInlineCode, parseReportText } from "./report-text";

describe("parseReportText", () => {
  it("splits paragraphs on blank lines", () => {
    expect(parseReportText("First line\nstill first.\n\nSecond.")).toEqual([
      { kind: "paragraph", text: "First line\nstill first." },
      { kind: "paragraph", text: "Second." },
    ]);
  });

  it("extracts fenced code with its language", () => {
    expect(parseReportText("Use a key:\n```TS\nconst a = 1;\n\nconst b = 2;\n```\nDone.")).toEqual([
      { kind: "paragraph", text: "Use a key:" },
      { kind: "code", language: "ts", code: "const a = 1;\n\nconst b = 2;" },
      { kind: "paragraph", text: "Done." },
    ]);
  });

  it("treats an unclosed fence as code to the end", () => {
    expect(parseReportText("```\n<script>alert(1)</script>")).toEqual([
      { kind: "code", language: "", code: "<script>alert(1)</script>" },
    ]);
  });

  it("groups bullet and numbered lists separately", () => {
    expect(parseReportText("Steps:\n1. one\n2) two\n- a\n* b\nAfter")).toEqual([
      { kind: "paragraph", text: "Steps:" },
      { kind: "list", ordered: true, items: ["one", "two"] },
      { kind: "list", ordered: false, items: ["a", "b"] },
      { kind: "paragraph", text: "After" },
    ]);
  });

  it("normalizes CRLF line endings", () => {
    expect(parseReportText("a\r\n\r\nb")).toEqual([
      { kind: "paragraph", text: "a" },
      { kind: "paragraph", text: "b" },
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(parseReportText("  \n\n")).toEqual([]);
  });
});

describe("parseInlineCode", () => {
  it("splits code spans from prose", () => {
    expect(parseInlineCode("Call `retry()` then `save`.")).toEqual([
      { kind: "text", text: "Call " },
      { kind: "code", text: "retry()" },
      { kind: "text", text: " then " },
      { kind: "code", text: "save" },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves unmatched backticks as text", () => {
    expect(parseInlineCode("a ` b")).toEqual([{ kind: "text", text: "a ` b" }]);
  });
});

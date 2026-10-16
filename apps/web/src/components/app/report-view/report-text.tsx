import { parseInlineCode, parseReportText } from "@/lib/report-text";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";

function Inline({ text }: { text: string }) {
  return parseInlineCode(text).map((segment, i) =>
    segment.kind === "code" ? (
      <code
        key={i}
        className="rounded border border-border-strong/50 bg-background/60 px-1 py-px font-mono text-[0.85em] break-words"
      >
        {segment.text}
      </code>
    ) : (
      <span key={i}>{segment.text}</span>
    ),
  );
}

/** Renders AI-written answer text with paragraphs, lists, inline code and fenced code blocks. */
export function ReportText({ text, className }: { text: string; className?: string }) {
  const blocks = parseReportText(text);
  return (
    <div className={cn("space-y-2.5 text-sm leading-relaxed text-foreground/95", className)}>
      {blocks.map((block, i) => {
        if (block.kind === "code") {
          return <CodeBlock key={i} code={block.code} language={block.language} />;
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={i} className={cn("space-y-1 pl-5", block.ordered ? "list-decimal" : "list-disc")}>
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} className="break-words whitespace-pre-wrap">
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

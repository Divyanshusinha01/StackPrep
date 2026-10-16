import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/ui/eyebrow";

type SectionHeadingProps = {
  id: string;
  eyebrow: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  align?: "left" | "center";
  className?: string;
};

export function SectionHeading({
  id,
  eyebrow,
  title,
  children,
  align = "left",
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn(align === "center" && "mx-auto text-center", "max-w-2xl", className)}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2
        id={id}
        className="mt-4 font-display text-3xl font-semibold tracking-[-0.03em] text-balance text-foreground sm:text-4xl lg:leading-[1.12]"
      >
        {title}
      </h2>
      {children ? (
        <p className="mt-5 text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
          {children}
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

export function SubmitButton({ children, pendingLabel, disabled, ...props }: React.ComponentProps<typeof Button> & {
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  const inactive = pending || Boolean(disabled);
  return (
    <Button type="submit" {...props} disabled={inactive} aria-disabled={inactive} aria-busy={pending || undefined}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

/**
 * Modal confirmation for destructive or irreversible actions. Focus starts on Cancel, Escape
 * cancels, and focus returns to the trigger. For a server action, keep the form around the trigger
 * and call `form.requestSubmit()` from `onConfirm` so the trigger's pending state still works.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  disabled = false,
  open,
  onOpenChange,
  onConfirm,
}: {
  /** A button element; it receives the open handler. */
  trigger: React.ReactElement;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  /** Disables the confirm button, e.g. while a previous request is still running. */
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={disabled}
            onClick={onConfirm}
            className={cn(tone === "danger" && "bg-danger text-primary-foreground hover:bg-danger/90")}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

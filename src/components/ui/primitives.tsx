// Lightweight, self-contained UI primitives (no shadcn/base-ui dependency).

import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, style, children }: { className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col rounded-lg border border-border bg-card shadow-sm", className)} style={style}>
      {children}
    </div>
  );
}

export function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground", className)}>
      {children}
    </span>
  );
}

export function Alert({
  variant = "default",
  className,
  children,
}: {
  variant?: "default" | "destructive";
  className?: string;
  children: React.ReactNode;
}) {
  const styles =
    variant === "destructive"
      ? "border-destructive/40 bg-destructive/10 text-red-300"
      : "border-border bg-card text-foreground";
  return <div className={cn("rounded-md border px-4 py-3 text-sm", styles, className)}>{children}</div>;
}

export function Button({
  className,
  disabled,
  onClick,
  children,
}: {
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Textarea({
  className,
  value,
  onChange,
  placeholder,
  textareaRef,
}: {
  className?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={cn(
        "w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary",
        className,
      )}
    />
  );
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-border", className)} />;
}

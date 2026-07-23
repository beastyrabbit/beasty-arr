import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-[6px] border font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 whitespace-nowrap cursor-pointer select-none",
  {
    variants: {
      variant: {
        primary: "border-accent bg-accent text-[#0e0f13] hover:bg-[#f5b45c]",
        outline: "border-line bg-transparent text-ink hover:bg-raised",
        ghost: "border-transparent bg-transparent text-muted hover:text-ink hover:bg-raised",
        danger: "border-missing/60 bg-transparent text-missing hover:bg-missing/10",
        subtle: "border-line bg-surface text-ink hover:bg-raised",
      },
      size: {
        sm: "h-6 px-2 text-[11px]",
        md: "h-7 px-2.5 text-[12px]",
        lg: "h-8 px-3.5 text-[13px]",
        icon: "h-6 w-6 p-0",
      },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type, ...props }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

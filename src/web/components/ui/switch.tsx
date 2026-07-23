import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative h-4 w-7 shrink-0 cursor-pointer rounded-full border border-line bg-raised transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-muted transition-transform data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-accent" />
    </SwitchPrimitive.Root>
  );
}

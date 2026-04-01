"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ThemeToggleProps = {
  /** Inline header style without the “Theme” label (for sticky top bar). */
  compact?: boolean;
};

export function ThemeToggle({ compact = false }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div
        className={compact ? "h-9 w-[11rem] rounded-md border border-border/60 bg-muted/30" : "h-9 w-full rounded-md border border-border/60 bg-muted/30"}
        aria-hidden
      />
    );
  }

  const t = theme ?? "dark";

  const controls = (
    <div className="flex rounded-lg border border-border bg-background/80 p-0.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-8 flex-1 gap-1.5 px-2 text-xs", t === "light" && "bg-secondary shadow-sm")}
          onClick={() => setTheme("light")}
        >
          <Sun className="h-3.5 w-3.5 shrink-0" />
          Light
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-8 flex-1 gap-1.5 px-2 text-xs", t === "dark" && "bg-secondary shadow-sm")}
          onClick={() => setTheme("dark")}
        >
          <Moon className="h-3.5 w-3.5 shrink-0" />
          Dark
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-8 flex-1 gap-1.5 px-2 text-xs", t === "system" && "bg-secondary shadow-sm")}
          onClick={() => setTheme("system")}
        >
          <Monitor className="h-3.5 w-3.5 shrink-0" />
          System
        </Button>
    </div>
  );

  if (compact) {
    return <div className="flex items-center">{controls}</div>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Theme</p>
      {controls}
    </div>
  );
}

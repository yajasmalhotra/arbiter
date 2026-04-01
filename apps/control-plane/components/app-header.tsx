"use client";

import { ThemeToggle } from "@/components/theme-toggle";

export function AppHeader() {
  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-end border-b bg-background/95 px-6 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-8">
      <ThemeToggle compact />
    </header>
  );
}

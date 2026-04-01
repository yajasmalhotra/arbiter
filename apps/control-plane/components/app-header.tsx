"use client";

import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

export function AppHeader() {
  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between border-b bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-8">
      <div className="flex items-center gap-2 md:hidden">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/">Dashboard</Link>
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/policies/new">Create</Link>
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/operations">Ops</Link>
        </Button>
      </div>
      <ThemeToggle compact />
    </header>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function Sidebar() {
  const pathname = usePathname();

  const dashboardActive =
    pathname === "/" || (pathname.startsWith("/policies/") && pathname !== "/policies/new");
  const createActive = pathname === "/policies/new";
  const operationsActive = pathname.startsWith("/operations");

  return (
    <aside className="hidden min-h-screen w-60 shrink-0 flex-col border-r bg-card/40 md:flex">
      <div className="p-4">
        <Link href="/" className="block font-semibold tracking-tight text-foreground">
          Arbiter
        </Link>
        <p className="mt-1 text-xs text-muted-foreground">Safety control center</p>
      </div>
      <Separator />
      <nav className="flex flex-col gap-1 p-3">
        <Button variant={dashboardActive ? "secondary" : "ghost"} className="justify-start" asChild>
          <Link href="/">Policy Dashboard</Link>
        </Button>
        <Button variant={createActive ? "secondary" : "ghost"} className="justify-start" asChild>
          <Link href="/policies/new">Create Rule</Link>
        </Button>
        <Button variant={operationsActive ? "secondary" : "ghost"} className="justify-start" asChild>
          <Link href="/operations">Operations</Link>
        </Button>
      </nav>
      <div className="mt-auto flex flex-col gap-4 p-4">
        <Separator />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Need secured actions? Set Connection Settings on the dashboard.
        </p>
      </div>
    </aside>
  );
}

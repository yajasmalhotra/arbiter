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

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-card/40 min-h-screen">
      <div className="p-4">
        <Link href="/" className="block font-semibold tracking-tight text-foreground">
          Arbiter
        </Link>
        <p className="mt-1 text-xs text-muted-foreground">Control plane</p>
      </div>
      <Separator />
      <nav className="flex flex-col gap-1 p-3">
        <Button variant={dashboardActive ? "secondary" : "ghost"} className="justify-start" asChild>
          <Link href="/">Dashboard</Link>
        </Button>
        <Button variant={createActive ? "secondary" : "ghost"} className="justify-start" asChild>
          <Link href="/policies/new">Create Policy</Link>
        </Button>
      </nav>
      <div className="mt-auto flex flex-col gap-4 p-4">
        <Separator />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Metadata: <code className="rounded bg-muted px-1 py-0.5 text-[10px]">.data/control-plane.json</code>
        </p>
      </div>
    </aside>
  );
}

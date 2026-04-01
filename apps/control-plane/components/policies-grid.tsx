"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AllCommunityModule,
  ModuleRegistry,
  colorSchemeDark,
  colorSchemeLight,
  themeQuartz,
  type CellContextMenuEvent,
  type ColDef,
  type ICellRendererParams,
  type RowClickedEvent
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { controlPlaneHeaders } from "@/lib/control-plane-client";
import { formatTimestamp, rolloutLabel } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import type { PolicyRecord } from "@/lib/types";

ModuleRegistry.registerModules([AllCommunityModule]);

type Props = {
  policies: PolicyRecord[];
};

type ContextMenuState = {
  x: number;
  y: number;
  policy: PolicyRecord;
};

export function PoliciesGrid({ policies }: Props) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const [quickFilter, setQuickFilter] = useState("");
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const gridTheme = useMemo(() => {
    const light = resolvedTheme === "light";
    return themeQuartz.withPart(light ? colorSchemeLight : colorSchemeDark);
  }, [resolvedTheme]);

  const columnDefs = useMemo<ColDef<PolicyRecord>[]>(
    () => [
      {
        field: "name",
        headerName: "Protection rule",
        flex: 1.2,
        minWidth: 160,
        cellRenderer: (params: ICellRendererParams<PolicyRecord>) => {
          const row = params.data;
          if (!row) return null;
          return (
            <Link
              href={`/policies/${encodeURIComponent(row.id)}`}
              className={cn("font-medium text-primary underline-offset-4 hover:underline")}
            >
              {row.name}
            </Link>
          );
        }
      },
      {
        field: "packageName",
        headerName: "Policy package",
        flex: 1,
        minWidth: 140
      },
      { field: "version", headerName: "Revision", width: 100 },
      {
        field: "rolloutState",
        headerName: "Status",
        width: 170,
        cellRenderer: (params: ICellRendererParams<PolicyRecord>) => {
          const row = params.data;
          if (!row) return null;
          const label = rolloutLabel(row.rolloutState);
          const tone =
            row.rolloutState === "enforced"
              ? "default"
              : row.rolloutState === "rolled_back"
                ? "destructive"
                : "secondary";
          return <Badge variant={tone}>{label}</Badge>;
        }
      },
      {
        field: "updatedAt",
        headerName: "Last updated",
        width: 220,
        sort: "desc",
        valueFormatter: (params) => formatTimestamp(String(params.value ?? ""))
      },
      {
        headerName: "Actions",
        width: 110,
        sortable: false,
        filter: false,
        suppressHeaderMenuButton: true,
        resizable: false,
        cellRenderer: (params: ICellRendererParams<PolicyRecord>) => {
          const row = params.data;
          if (!row) return null;
          return (
            <Button size="sm" variant="ghost" asChild>
              <Link href={`/policies/${encodeURIComponent(row.id)}/edit`}>Edit</Link>
            </Button>
          );
        }
      }
    ],
    []
  );

  const onCellContextMenu = useCallback((e: CellContextMenuEvent<PolicyRecord>) => {
    const native = e.event;
    if (!native) return;
    native.preventDefault();
    const data = e.node?.data;
    if (!data) return;
    const ev = native as MouseEvent;
    setMenu({ x: ev.clientX, y: ev.clientY, policy: data });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const onRowClicked = useCallback(
    (event: RowClickedEvent<PolicyRecord>) => {
      const policy = event.data;
      if (!policy) return;
      router.push(`/policies/${encodeURIComponent(policy.id)}`);
    },
    [router]
  );

  const gridShellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = gridShellRef.current;
    if (!el) return;
    const suppressBrowserMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    el.addEventListener("contextmenu", suppressBrowserMenu, { capture: true });
    return () => el.removeEventListener("contextmenu", suppressBrowserMenu, { capture: true });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onDown = (ev: MouseEvent) => {
      if (menuRef.current?.contains(ev.target as Node)) return;
      closeMenu();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closeMenu();
    };
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeMenu]);

  async function handleDelete(policy: PolicyRecord) {
    closeMenu();
    if (!window.confirm(`Delete policy "${policy.name}"? This cannot be undone.`)) {
      return;
    }
    const res = await fetch(`/api/policies/${encodeURIComponent(policy.id)}`, {
      method: "DELETE",
      headers: controlPlaneHeaders()
    });
    if (!res.ok) {
      alert("Delete failed");
      return;
    }
    router.refresh();
  }

  function goEdit(policy: PolicyRecord) {
    closeMenu();
    router.push(`/policies/${encodeURIComponent(policy.id)}/edit`);
  }

  if (policies.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="mb-4 text-sm text-muted-foreground">No policies yet.</p>
        <Button asChild>
          <Link href="/policies/new">Create Policy</Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-4 grid gap-3 rounded-lg border bg-muted/20 p-4 md:grid-cols-[1fr_auto] md:items-end">
        <div className="grid gap-1">
          <p className="text-sm font-medium">Find a policy quickly</p>
          <p className="text-xs text-muted-foreground">
            Search by rule name, package, or status. Click a row to open details.
          </p>
        </div>
        <Input
          value={quickFilter}
          onChange={(e) => setQuickFilter(e.target.value)}
          placeholder="Search policies"
          className="md:w-72"
        />
      </div>
      <div ref={gridShellRef} className="h-[520px] w-full" key={resolvedTheme ?? "dark"}>
        <AgGridReact<PolicyRecord>
          theme={gridTheme}
          rowData={policies}
          columnDefs={columnDefs}
          defaultColDef={{
            sortable: true,
            filter: true,
            resizable: true,
            suppressHeaderMenuButton: false
          }}
          onCellContextMenu={onCellContextMenu}
          onRowClicked={onRowClicked}
          quickFilterText={quickFilter}
          animateRows
          pagination
          paginationPageSize={20}
          paginationPageSizeSelector={[10, 20, 50]}
        />
      </div>

      {menu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[100] min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 slide-in-from-left-2 duration-150"
            style={{
              left: Math.min(menu.x, window.innerWidth - 208),
              top: Math.min(menu.y, window.innerHeight - 100)
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Policy</p>
            <button
              type="button"
              role="menuitem"
              className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
              onClick={() => goEdit(menu.policy)}
            >
              <Pencil className="h-4 w-4 opacity-70" />
              Edit
            </button>
            <button
              type="button"
              role="menuitem"
              className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none transition-colors hover:bg-destructive/15 hover:text-destructive focus:bg-destructive/15"
              onClick={() => void handleDelete(menu.policy)}
            >
              <Trash2 className="h-4 w-4 opacity-70" />
              Delete
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

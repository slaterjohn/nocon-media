"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Film } from "lucide-react";
import { cn } from "@/lib/utils";
import { manageNav, watchNav, type NavItem } from "@/lib/nav";
import { useApi } from "@/lib/api";
import type { User } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { LoadingSkeleton } from "./states";
import { HeaderBar } from "./header";

function NavGroup({ label, items, onNavigate }: { label: string; items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const headingId = `nav-${label.toLowerCase()}`;
  return (
    <nav aria-labelledby={headingId} className="space-y-1">
      <h2 id={headingId} className="px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h2>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
                  active && "bg-accent font-medium text-accent-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <Link href="/" onClick={onNavigate} className="flex items-center gap-2 px-3 text-lg font-semibold">
        <Film className="size-5 text-primary" aria-hidden="true" />
        NoConMedia
      </Link>
      <NavGroup label="Watch" items={watchNav} onNavigate={onNavigate} />
      <NavGroup label="Manage" items={manageNav} onNavigate={onNavigate} />
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  const me = useApi<{ user: User }>("/api/auth/me");

  React.useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-[200] rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>
      <aside
        aria-label="Sidebar"
        className="fixed inset-y-0 left-0 hidden w-60 overflow-y-auto border-r bg-sidebar p-3 lg:block"
      >
        <SidebarContent />
      </aside>
      <div className="lg:pl-60">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur sm:px-4">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden">
                <Menu aria-hidden="true" />
                <span className="sr-only">Open menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <SheetDescription className="sr-only">Site navigation</SheetDescription>
              <SidebarContent onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <HeaderBar username={me.data?.user.username} />
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl p-4 outline-none sm:p-6">
          {me.isLoading ? <LoadingSkeleton variant="page" label="Loading page" /> : children}
        </main>
      </div>
    </div>
  );
}

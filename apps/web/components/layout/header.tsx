"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell, LogOut, Search, User as UserIcon, Wifi, WifiOff, Check, CheckCheck } from "lucide-react";
import { api, post, useApi, errorMessage } from "@/lib/api";
import type { AppNotification, Dashboard } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { ThemeToggle } from "./theme";

function SearchBox() {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  return (
    <form
      role="search"
      className="relative min-w-0 max-w-md flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        const t = q.trim();
        if (t) router.push(`/search?q=${encodeURIComponent(t)}`);
      }}
    >
      <label htmlFor="global-search" className="sr-only">
        Search the library
      </label>
      <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
      <Input id="global-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search videos, channels, playlists" className="pl-8" />
    </form>
  );
}

function ConnectivityBadge() {
  const { data } = useApi<Dashboard>("/api/dashboard", { refreshInterval: 30000 });
  if (!data) return null;
  const online = data.connectivity.online;
  return (
    <Badge variant={online ? "success" : "warning"} className="hidden sm:inline-flex">
      {online ? <Wifi className="size-3" aria-hidden="true" /> : <WifiOff className="size-3" aria-hidden="true" />}
      {online ? "Online" : "Offline"}
      <span className="sr-only">{online ? ": downloads can run" : ": playing local files only"}</span>
    </Badge>
  );
}

function Notifications() {
  const { toast } = useToast();
  const { data, error, mutate } = useApi<{ items: AppNotification[]; unread: number }>("/api/notifications?open=true", {
    refreshInterval: 30000,
  });
  const unread = data?.unread ?? 0;

  async function act(path: string) {
    try {
      await post(path);
      await mutate();
    } catch (e) {
      toast({ title: "Couldn't update the notification", description: errorMessage(e), variant: "error" });
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell aria-hidden="true" />
          {unread > 0 ? (
            <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
          <span className="sr-only">Notifications{unread > 0 ? `, ${unread} unread` : ""}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))]">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Notifications</h2>
          {unread > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => act("/api/notifications/read-all")}>
              <CheckCheck aria-hidden="true" /> Mark all read
            </Button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">{error.message}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data.items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Nothing needs attention.</p>
        ) : (
          <ul className="max-h-96 space-y-2 overflow-y-auto">
            {data.items.map((n) => (
              <li key={n.id} className="rounded-md border p-2 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <p className={n.readAt ? "font-normal" : "font-semibold"}>
                    {n.title}
                    {n.count > 1 ? <span className="ml-1 text-xs text-muted-foreground">x{n.count}</span> : null}
                  </p>
                  <Badge variant={n.severity === "error" ? "destructive" : n.severity === "warning" ? "warning" : "secondary"}>
                    {n.severity}
                  </Badge>
                </div>
                {n.body ? <p className="mt-1 text-muted-foreground">{n.body}</p> : null}
                {n.remediation ? <p className="mt-1">{n.remediation}</p> : null}
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{timeAgo(n.updatedAt)}</span>
                  <span className="flex gap-1">
                    {!n.readAt ? (
                      <Button variant="ghost" size="sm" onClick={() => act(`/api/notifications/${n.id}/read`)}>
                        Mark read
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={() => act(`/api/notifications/${n.id}/resolve`)}>
                      <Check aria-hidden="true" /> Resolve
                    </Button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function HeaderBar({ username }: { username?: string }) {
  const { toast } = useToast();
  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST", noRedirect: true });
    } catch (e) {
      toast({ title: "Couldn't sign out", description: errorMessage(e), variant: "error" });
      return;
    }
    window.location.assign("/login");
  }
  return (
    <>
      <SearchBox />
      <div className="ml-auto flex items-center gap-1">
        <ConnectivityBadge />
        <ThemeToggle />
        <Notifications />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <UserIcon aria-hidden="true" />
              <span className="sr-only">Account menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Signed in as {username ?? "…"}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void logout()}>
              <LogOut aria-hidden="true" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

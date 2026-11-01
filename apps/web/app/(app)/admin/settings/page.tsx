"use client";

import * as React from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import type { DiscoveryMode, Settings } from "@/lib/types";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/states";

const MODE: Record<DiscoveryMode, string> = {
  approval: "suggest for approval",
  auto: "download automatically",
  discovery_only: "catalogue only",
};

const on = (v: boolean) => (v ? "on" : "off");

interface HubItem {
  href: string;
  title: string;
  description: string;
  summary?: string;
}

function items(s: Settings | undefined): HubItem[] {
  return [
    {
      href: "/admin/settings/general",
      title: "General",
      description: "How much NoConMedia runs at once, and the video quality sources use by default.",
      summary: s ? `${s.profile === "lightweight" ? "Lightweight" : "Standard"} profile, ${s.defaultResolution}p` : undefined,
    },
    {
      href: "/admin/settings/storage",
      title: "Storage",
      description: "How much disk space NoConMedia leaves free and when it starts removing recommendations.",
      summary: s ? `Soft limit ${s.softThreshold}%, keep ${s.minFreePercent}% free` : undefined,
    },
    {
      href: "/admin/settings/players",
      title: "External player access",
      description: "Whether apps such as UHF and VLC can connect, and from which networks.",
      summary: s ? `Xtream ${on(s.enableXtream)}, M3U ${on(s.enableM3u)}` : undefined,
    },
    {
      href: "/admin/settings/discovery",
      title: "Discovery",
      description: "How many recommendations discovery keeps, how much it may download and how far it looks.",
      summary: s ? (s.discovery.enabled ? `On, ${MODE[s.discovery.mode] ?? s.discovery.mode}` : "Off") : undefined,
    },
    {
      href: "/admin/settings/account",
      title: "Account and security",
      description: "Change your password and sign out devices you don't recognise.",
    },
  ];
}

export default function SettingsHubPage() {
  const result = useApi<Settings>("/api/settings");
  return (
    <>
      <PageHeader title="Settings" description="Choose what to change. Each page has its own Save button." />
      <ul className="grid max-w-4xl gap-4 sm:grid-cols-2">
        {items(result.data).map((it) => (
          <li key={it.href}>
            <Card className="relative h-full transition-colors hover:bg-accent has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
              <CardHeader className="pb-4">
                <CardTitle>
                  <Link href={it.href} className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">{it.title}</Link>
                </CardTitle>
                <CardDescription>{it.description}</CardDescription>
                {it.summary ? <p className="mt-1 text-sm font-medium">{it.summary}</p> : null}
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

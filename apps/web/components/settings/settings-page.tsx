"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { get, put } from "@/lib/api";
import type { Settings } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/states";
import { Breadcrumb } from "@/components/common/breadcrumb";

/** Page frame for one settings page: breadcrumb, h1, content. */
export function SettingsPageShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <>
      <Breadcrumb items={[{ label: "Settings", href: "/admin/settings" }, { label: title }]} />
      <PageHeader title={title} description={description} />
      <div className="max-w-3xl">{children}</div>
    </>
  );
}

/** The single Save button for a page, with a link back to the hub. */
export function SettingsFooter({ busy, label = "Save", busyLabel = "Saving…" }: { busy: boolean; label?: string; busyLabel?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Button type="submit" disabled={busy}>{busy ? busyLabel : label}</Button>
      <Link href="/admin/settings" className="inline-flex items-center gap-1 text-sm underline underline-offset-2"><ArrowLeft className="size-4" aria-hidden="true" /> Back to Settings</Link>
    </div>
  );
}

/**
 * Settings are one record on the API. Read the latest copy just before writing so a page only changes its own fields.
 */
export async function saveSettingsPatch(patch: Partial<Settings>): Promise<Settings> {
  const current = await get<Settings>("/api/settings");
  return put<Settings>("/api/settings", { ...current, ...patch });
}

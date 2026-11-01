"use client";

import * as React from "react";
import { del, errorMessage, post, useApi } from "@/lib/api";
import type { SessionInfo } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { useAction } from "@/hooks/use-action";
import { useToast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Field, FormError } from "@/components/common/form";
import { Query } from "@/components/common/data";
import { SettingsPageShell } from "@/components/settings/settings-page";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

function PasswordForm() {
  const { toast } = useToast();
  const [cur, setCur] = React.useState("");
  const [nw, setNw] = React.useState("");
  const [conf, setConf] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!cur) fe.cur = "Enter your current password.";
    if (nw.length < 10) fe.nw = "Use at least 10 characters.";
    if (conf !== nw) fe.conf = "The passwords don't match.";
    setErrors(fe); setError(null);
    if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      await post("/api/auth/password", { currentPassword: cur, newPassword: nw });
      toast({ title: "Password changed", variant: "success" });
      setCur(""); setNw(""); setConf("");
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <Card>
      <CardHeader><CardTitle>Change password</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="max-w-sm space-y-4">
          <FormError message={error} />
          <Field id="pw-cur" label="Current password" error={errors.cur}>{(p) => <Input {...p} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />}</Field>
          <Field id="pw-new" label="New password" hint="At least 10 characters." error={errors.nw}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={nw} onChange={(e) => setNw(e.target.value)} />}</Field>
          <Field id="pw-conf" label="Confirm new password" error={errors.conf}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={conf} onChange={(e) => setConf(e.target.value)} />}</Field>
          <Button type="submit" disabled={busy}>{busy ? "Changing…" : "Change password"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Sessions() {
  const result = useApi<{ items: SessionInfo[] }>("/api/auth/sessions");
  const { run, busy } = useAction();
  return (
    <Card>
      <CardHeader><CardTitle>Signed-in sessions</CardTitle><CardDescription>Revoke any you don't recognise.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <Query result={result}>
          {({ items }) => (
            <>
              <Table aria-label="Sessions">
                <TableHeader><TableRow><TableHead>Device</TableHead><TableHead>IP address</TableHead><TableHead>Signed in</TableHead><TableHead>Last active</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
                <TableBody>
                  {items.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="max-w-72 truncate" title={s.userAgent ?? undefined}>{s.userAgent ?? "Unknown"} {s.current ? <Badge variant="success">This session</Badge> : null}</TableCell>
                      <TableCell>{s.ip ?? "–"}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(s.createdAt)}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(s.lastSeenAt)}</TableCell>
                      <TableCell>{s.current ? null : <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(s.id, async () => { await del(`/api/auth/sessions/${s.id}`); await result.mutate(); }, { success: "Session revoked" })}>Revoke<span className="sr-only"> session from {s.ip ?? "unknown address"}</span></Button>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {items.some((s) => !s.current) ? <Button variant="outline" disabled={busy !== null} onClick={() => void run("all", async () => { await del("/api/auth/sessions"); await result.mutate(); }, { success: "Other sessions revoked" })}>Revoke all other sessions</Button> : null}
            </>
          )}
        </Query>
      </CardContent>
    </Card>
  );
}

export default function AccountSettingsPage() {
  return (
    <SettingsPageShell title="Account and security" description="Change your password and sign out devices you don't recognise.">
      <div className="space-y-6">
        <PasswordForm />
        <Sessions />
        <Link href="/admin/settings" className="inline-flex items-center gap-1 text-sm underline underline-offset-2"><ArrowLeft className="size-4" aria-hidden="true" /> Back to Settings</Link>
      </div>
    </SettingsPageShell>
  );
}

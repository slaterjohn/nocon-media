"use client";

import * as React from "react";
import Link from "next/link";
import { MonitorSmartphone, Plus } from "lucide-react";
import { del, errorMessage, patch, post, useApi } from "@/lib/api";
import type { ExternalClient } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import { useAction } from "@/hooks/use-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/layout/states";
import { Field, FormError, ToggleRow } from "@/components/common/form";
import { Query } from "@/components/common/data";
import { StatusBadge } from "@/components/common/badges";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { CopyButton } from "@/components/common/copy-button";

interface Credentials { name: string; server: string; username: string; password: string; m3uUrl?: string; rotated?: boolean }

function CredRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
      <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="font-mono text-sm break-all">{value}</p></div>
      <CopyButton value={value} label={label} />
    </div>
  );
}

function CredentialsDialog({ creds, onClose }: { creds: Credentials | null; onClose: () => void }) {
  return (
    <Dialog open={!!creds} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        {creds ? (
          <>
            <DialogHeader>
              <DialogTitle>{creds.rotated ? "New password" : "Player created"}: {creds.name}</DialogTitle>
              <DialogDescription>Copy the password now. It's shown once and can't be retrieved later. If it's lost, rotate it.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <CredRow label="Server URL" value={creds.server} />
              <CredRow label="Username" value={creds.username} />
              <CredRow label="Password" value={creds.password} />
              {creds.m3uUrl ? <CredRow label="M3U URL" value={creds.m3uUrl} /> : null}
            </div>
            <section aria-labelledby="uhf-steps" className="text-sm">
              <h3 id="uhf-steps" className="mb-1 font-semibold">Set up UHF</h3>
              <ol className="list-decimal space-y-1 pl-5">
                <li>Open UHF and go to Settings, then Add Channels.</li>
                <li>Choose Xtream Codes.</li>
                <li>Enter the server URL, username and password above.</li>
                <li>Save. Your library appears as channels and movies.</li>
              </ol>
              <p className="mt-2 text-muted-foreground">Apps without Xtream support can use the M3U URL instead. The device must be on the same network as this server.</p>
            </section>
            <DialogFooter><Button onClick={onClose}>I've saved the password</Button></DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog({ open, onOpenChange, serverUrl, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; serverUrl: string; onCreated: (c: Credentials) => void }) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState("xtream");
  const [xt, setXt] = React.useState(true);
  const [m3, setM3] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [nameErr, setNameErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setName(""); setErr(null); setNameErr(null); } }, [open]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setNameErr("Give the player a name, such as Living room TV."); return; }
    setNameErr(null); setBusy(true); setErr(null);
    try {
      const r = await post<{ client: ExternalClient; password: string; m3uUrl?: string; xtream?: { server: string; username: string; password: string } }>("/api/clients", { name: name.trim(), kind, allowXtream: xt, allowM3u: m3 });
      onCreated({ name: r.client.name, server: r.xtream?.server ?? serverUrl, username: r.xtream?.username ?? r.client.username, password: r.xtream?.password ?? r.password, m3uUrl: r.m3uUrl });
      onOpenChange(false);
    } catch (e2) { setErr(errorMessage(e2)); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <DialogHeader><DialogTitle>Add an external player</DialogTitle><DialogDescription>Each player gets its own login, so you can disable one without affecting the others.</DialogDescription></DialogHeader>
          <FormError message={err} />
          <Field id="cl-name" label="Name" error={nameErr}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
          <Field id="cl-kind" label="Type" hint="Choose Browser extension to record watch history from the browser.">{(p) => <Select {...p} value={kind} onChange={(e) => setKind(e.target.value)}><option value="xtream">Media player (Xtream or M3U)</option><option value="extension">Browser extension</option></Select>}</Field>
          {kind === "xtream" ? (
            <>
              <ToggleRow id="cl-xt" label="Allow Xtream">{(p) => <Checkbox {...p} checked={xt} onCheckedChange={(v) => setXt(v === true)} />}</ToggleRow>
              <ToggleRow id="cl-m3" label="Allow M3U">{(p) => <Checkbox {...p} checked={m3} onCheckedChange={(v) => setM3(v === true)} />}</ToggleRow>
            </>
          ) : null}
          <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ClientsPage() {
  const result = useApi<{ items: ExternalClient[]; serverUrl: string; xtreamEnabled: boolean; m3uEnabled: boolean }>("/api/clients", { refreshInterval: 30000 });
  const { run, busy } = useAction();
  const [creating, setCreating] = React.useState(false);
  const [creds, setCreds] = React.useState<Credentials | null>(null);
  const [revoking, setRevoking] = React.useState<ExternalClient | null>(null);

  return (
    <>
      <PageHeader title="External players" description="Logins for apps such as UHF and VLC, and for the browser extension. These never grant access to the admin interface."
        actions={<Button onClick={() => setCreating(true)}><Plus aria-hidden="true" /> Add player</Button>} />
      <Query result={result}>
        {(d) => (
          <>
            {!d.xtreamEnabled || !d.m3uEnabled ? (
              <p className="mb-4 text-sm text-warning">{!d.xtreamEnabled ? "Xtream is turned off. " : ""}{!d.m3uEnabled ? "M3U is turned off. " : ""}Change this in <Link href="/admin/settings/players" className="underline">Settings, External player access</Link>.</p>
            ) : null}
            {d.items.length === 0 ? (
              <EmptyState icon={MonitorSmartphone} title="No external players" description="Add a player to get a server URL, username and password for UHF or VLC." action={<Button onClick={() => setCreating(true)}>Add player</Button>} />
            ) : (
              <Table aria-label="External players">
                <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Username</TableHead><TableHead>Access</TableHead><TableHead>Status</TableHead><TableHead>Last used</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
                <TableBody>
                  {d.items.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell>{c.kind}</TableCell>
                      <TableCell className="font-mono text-xs">{c.username}</TableCell>
                      <TableCell className="space-x-1">{c.allowXtream ? <Badge variant="outline">Xtream</Badge> : null}{c.allowM3u ? <Badge variant="outline">M3U</Badge> : null}</TableCell>
                      <TableCell><StatusBadge status={c.status} /></TableCell>
                      <TableCell className="whitespace-nowrap">{timeAgo(c.lastUsedAt)}{c.lastIp ? <span className="block text-xs text-muted-foreground">{c.lastIp}</span> : null}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(c.id, async () => {
                            const r = await post<{ password: string; client?: ExternalClient; xtream?: { server: string; username: string; password: string }; m3uUrl?: string }>(`/api/clients/${c.id}/rotate`);
                            setCreds({ name: c.name, server: r.xtream?.server ?? d.serverUrl, username: r.xtream?.username ?? c.username, password: r.xtream?.password ?? r.password, m3uUrl: r.m3uUrl, rotated: true });
                            await result.mutate();
                          })}>Rotate password<span className="sr-only"> for {c.name}</span></Button>
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(c.id, async () => { await patch(`/api/clients/${c.id}`, { status: c.status === "active" ? "disabled" : "active" }); await result.mutate(); }, { success: c.status === "active" ? `${c.name} disabled` : `${c.name} enabled` })}>{c.status === "active" ? "Disable" : "Enable"}<span className="sr-only"> {c.name}</span></Button>
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRevoking(c)}>Revoke<span className="sr-only"> {c.name}</span></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <CreateDialog open={creating} onOpenChange={setCreating} serverUrl={d.serverUrl} onCreated={(c) => { setCreds(c); void result.mutate(); }} />
          </>
        )}
      </Query>
      <CredentialsDialog creds={creds} onClose={() => setCreds(null)} />
      {revoking ? (
        <ConfirmDialog open onOpenChange={(o) => !o && setRevoking(null)} destructive title={`Revoke ${revoking.name}?`} confirmLabel="Revoke" description="The player stops working straight away and its login is deleted. You can add it again with a new password."
          onConfirm={async () => { await del(`/api/clients/${revoking.id}`); await result.mutate(); }} />
      ) : null}
    </>
  );
}

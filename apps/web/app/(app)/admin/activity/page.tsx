"use client";

import * as React from "react";
import { Activity } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { ActivityEvent } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";

export default function ActivityPage() {
  const [q, setQ] = React.useState("");
  const [dq, setDq] = React.useState("");
  const [type, setType] = React.useState("");
  const [severity, setSeverity] = React.useState("");
  const [items, setItems] = React.useState<ActivityEvent[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  React.useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const query = React.useCallback((before?: string | null) => {
    const p = new URLSearchParams({ limit: "50" });
    if (dq) p.set("q", dq);
    if (type.trim()) p.set("type", type.trim().replace(/\s+/g, ""));
    if (severity) p.set("severity", severity);
    if (before) p.set("before", before);
    return `/api/activity?${p}`;
  }, [dq, type, severity]);

  const load = React.useCallback(async () => {
    setItems(null); setError(null);
    try {
      const r = await api<{ items: ActivityEvent[]; nextCursor: string | null }>(query());
      setItems(r.items); setCursor(r.nextCursor ?? null);
    } catch (e) { setError(errorMessage(e)); }
  }, [query]);
  React.useEffect(() => { void load(); }, [load]);

  async function more() {
    setLoadingMore(true);
    try {
      const r = await api<{ items: ActivityEvent[]; nextCursor: string | null }>(query(cursor));
      setItems((cur) => [...(cur ?? []), ...r.items]); setCursor(r.nextCursor ?? null);
    } catch (e) { setError(errorMessage(e)); } finally { setLoadingMore(false); }
  }

  return (
    <>
      <PageHeader title="Activity" description="What NoConMedia has done and any problems it ran into, newest first." />
      <form role="search" className="mb-4 grid gap-2 sm:grid-cols-3" onSubmit={(e) => e.preventDefault()}>
        <div><label htmlFor="a-q" className="sr-only">Search messages</label><Input id="a-q" type="search" placeholder="Search messages" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div><label htmlFor="a-type" className="sr-only">Event types</label><Input id="a-type" placeholder="Event types, comma separated" value={type} onChange={(e) => setType(e.target.value)} /></div>
        <div><label htmlFor="a-sev" className="sr-only">Severity</label>
          <Select id="a-sev" value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="">Any severity</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></Select></div>
      </form>
      {error && !items ? <ErrorState message={error} onRetry={() => void load()} /> : !items ? <LoadingSkeleton rows={8} /> : items.length === 0 ? (
        <EmptyState icon={Activity} title="No activity matches" description="Change the filters, or check back after the next sync." />
      ) : (
        <>
          <Table aria-label="Activity">
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Severity</TableHead><TableHead>Type</TableHead><TableHead>Message</TableHead></TableRow></TableHeader>
            <TableBody>
              {items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(e.at)}</TableCell>
                  <TableCell><Badge variant={e.severity === "error" ? "destructive" : e.severity === "warning" ? "warning" : "secondary"}>{e.severity}</Badge></TableCell>
                  <TableCell className="font-mono text-xs">{e.type}</TableCell>
                  <TableCell>{e.message}{e.entityType ? <span className="block text-xs text-muted-foreground">{e.entityType}{e.entityId ? ` ${e.entityId}` : ""}</span> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 flex justify-center" aria-live="polite">
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {cursor ? <Button variant="outline" onClick={() => void more()} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more"}</Button> : <p className="text-sm text-muted-foreground">That's everything.</p>}
          </div>
        </>
      )}
    </>
  );
}

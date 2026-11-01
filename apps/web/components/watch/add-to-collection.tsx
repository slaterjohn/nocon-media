"use client";

import * as React from "react";
import { Check, FolderPlus } from "lucide-react";
import { ApiError, errorMessage, post, useApi } from "@/lib/api";
import type { Collection } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/components/ui/toast";

export function AddToCollection({ mediaId }: { mediaId: string }) {
  const [open, setOpen] = React.useState(false);
  const result = useApi<{ items: Collection[] }>("/api/collections", { enabled: open });
  const { toast } = useToast();
  const [added, setAdded] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<"collection" | "playlist">("collection");
  const [error, setError] = React.useState<string | null>(null);

  async function add(c: Collection) {
    setBusy(c.id);
    try {
      await post(`/api/collections/${c.id}/items`, { mediaId });
      setAdded((s) => new Set(s).add(c.id));
      toast({ title: `Added to ${c.name}`, variant: "success" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setAdded((s) => new Set(s).add(c.id));
        toast({ title: `Already in ${c.name}` });
      } else toast({ title: "Couldn't add it", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    setError(null);
    setBusy("new");
    try {
      const res = await post<{ collection?: Collection } & Partial<Collection>>("/api/collections", { name: name.trim(), kind });
      const created = (res.collection ?? res) as Collection;
      if (created.id) await post(`/api/collections/${created.id}/items`, { mediaId });
      toast({ title: `Created ${name.trim()} and added this video`, variant: "success" });
      setName("");
      await result.mutate();
      if (created.id) setAdded((s) => new Set(s).add(created.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm"><FolderPlus aria-hidden="true" /> Add to collection</Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Add to a collection or playlist">
        <h3 className="mb-2 text-sm font-semibold">Add to a collection or playlist</h3>
        <div className="max-h-48 overflow-y-auto" aria-live="polite">
          {result.error ? <p className="text-sm text-destructive">{result.error.message}</p> : null}
          {!result.data && !result.error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {result.data && result.data.items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet. Create one below.</p> : null}
          <ul className="space-y-1">
            {result.data?.items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-60"
                  disabled={busy !== null || added.has(c.id)}
                  onClick={() => void add(c)}
                >
                  <span className="min-w-0 truncate">{c.name} <span className="text-xs text-muted-foreground">({c.kind === "playlist" ? "playlist" : "collection"})</span></span>
                  {added.has(c.id) ? <span className="flex items-center gap-1 text-xs text-success"><Check className="size-3" aria-hidden="true" /> Added</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <form onSubmit={create} noValidate className="mt-3 space-y-2 border-t pt-3">
          <Label htmlFor="new-col-name" className="text-xs">Create new</Label>
          <Input id="new-col-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-invalid={error ? true : undefined} aria-describedby={error ? "new-col-err" : undefined} />
          <Label htmlFor="new-col-kind" className="sr-only">Type</Label>
          <Select id="new-col-kind" value={kind} onChange={(e) => setKind(e.target.value as "collection" | "playlist")}>
            <option value="collection">Collection</option>
            <option value="playlist">Playlist (ordered)</option>
          </Select>
          {error ? <p id="new-col-err" className="text-xs font-medium text-destructive">{error}</p> : null}
          <Button type="submit" size="sm" disabled={busy !== null}>{busy === "new" ? "Creating…" : "Create and add"}</Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

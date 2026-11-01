"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderOpen, ListVideo, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { del, errorMessage, patch, post, useApi } from "@/lib/api";
import type { Collection, MediaSummary, PlaylistRef } from "@/lib/types";
import { useAction } from "@/hooks/use-action";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, PageHeader } from "@/components/layout";
import { Query } from "@/components/common/data";
import { Field, FormError } from "@/components/common/form";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { MediaCard, MediaGrid, PlaylistCard } from "@/components/media/media-card";
import { GridSkeleton } from "@/components/media/media-list";

/** Detail responses may nest items under `collection` or beside it. */
function normaliseDetail(data: { collection?: Collection; items?: MediaSummary[] } & Partial<Collection>): { collection: Collection; items: MediaSummary[] } {
  const c = (data.collection ?? data) as Collection;
  return { collection: c, items: c.items ?? data.items ?? [] };
}

function CollectionFormDialog({
  open,
  onOpenChange,
  kind,
  existing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  kind: "collection" | "playlist";
  existing?: Collection;
  onSaved: (c: Collection) => void;
}) {
  const [name, setName] = React.useState(existing?.name ?? "");
  const [description, setDescription] = React.useState(existing?.description ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nameError, setNameError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setName(existing?.name ?? "");
      setDescription(existing?.description ?? "");
      setError(null);
      setNameError(null);
    }
  }, [open, existing]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setNameError("Enter a name.");
      return;
    }
    setNameError(null);
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim() || undefined };
      const res = existing
        ? await patch<{ collection?: Collection } & Partial<Collection>>(`/api/collections/${existing.id}`, { ...body, description: description.trim() })
        : await post<{ collection?: Collection } & Partial<Collection>>("/api/collections", { ...body, kind });
      onSaved((res.collection ?? res) as Collection);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const noun = kind === "playlist" ? "playlist" : "collection";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? `Rename ${noun}` : `New ${noun}`}</DialogTitle>
          <DialogDescription>{existing ? "Change the name or description." : `Give the ${noun} a name. Add videos from any video's page.`}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <FormError message={error} />
          <Field id="col-name" label="Name" error={nameError}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />}
          </Field>
          <Field id="col-desc" label="Description" optional>
            {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : existing ? "Save" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CollectionsView() {
  const result = useApi<{ items: Collection[] }>("/api/collections");
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  return (
    <>
      <PageHeader
        title="Collections"
        description="Groups of videos you choose, such as a course or a project."
        actions={<Button onClick={() => setCreating(true)}><Plus aria-hidden="true" /> New collection</Button>}
      />
      <Query result={result} skeleton={<GridSkeleton count={4} />}>
        {({ items }) => {
          const list = items.filter((c) => c.kind !== "playlist");
          return list.length === 0 ? (
            <EmptyState icon={FolderOpen} title="No collections yet" description="Create one, then add videos from any video's page." action={<Button onClick={() => setCreating(true)}>New collection</Button>} />
          ) : (
            <ul className="grid gap-x-4 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
              {list.map((c) => (
                <li key={c.id}>
                  <PlaylistCard playlist={c} href={`/collections/${c.id}`} />
                  {c.description ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{c.description}</p> : null}
                </li>
              ))}
            </ul>
          );
        }}
      </Query>
      <CollectionFormDialog open={creating} onOpenChange={setCreating} kind="collection" onSaved={(c) => (c.id ? router.push(`/collections/${c.id}`) : void result.mutate())} />
    </>
  );
}

export function CollectionDetailView({ id }: { id: string }) {
  const result = useApi<{ collection?: Collection; items?: MediaSummary[] } & Partial<Collection>>(`/api/collections/${id}`);
  const router = useRouter();
  const { run, busy } = useAction();
  const [renaming, setRenaming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  return (
    <Query result={result} skeleton={<GridSkeleton />}>
      {(data) => {
        const { collection, items } = normaliseDetail(data);
        return (
          <>
            <PageHeader
              title={collection.name}
              description={collection.description || `${items.length} ${items.length === 1 ? "video" : "videos"}`}
              actions={
                <>
                  {items.some((m) => m.playable) ? (
                    <Button asChild>
                      <Link href={`/watch/${items.find((m) => m.playable)!.id}?list=${id}`}><Play aria-hidden="true" /> Play all</Link>
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={() => setRenaming(true)}><Pencil aria-hidden="true" /> Rename</Button>
                  <Button variant="outline" onClick={() => setDeleting(true)}><Trash2 aria-hidden="true" /> Delete</Button>
                </>
              }
            />
            {items.length === 0 ? (
              <EmptyState icon={ListVideo} title="This collection is empty" description="Open a video and use Add to collection." action={<Button asChild variant="outline"><Link href="/library">Browse the library</Link></Button>} />
            ) : (
              <MediaGrid label={`Videos in ${collection.name}`}>
                {items.map((m) => (
                  <MediaCard
                    key={m.id}
                    media={m}
                    listId={id}
                    footer={
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-muted-foreground"
                        disabled={busy !== null}
                        onClick={() => void run(m.id, async () => { await del(`/api/collections/${id}/items/${m.id}`); await result.mutate(); }, { success: "Removed from collection" })}
                      >
                        Remove<span className="sr-only"> {m.title} from this collection</span>
                      </Button>
                    }
                  />
                ))}
              </MediaGrid>
            )}
            <CollectionFormDialog open={renaming} onOpenChange={setRenaming} kind="collection" existing={{ ...collection, id }} onSaved={() => void result.mutate()} />
            <ConfirmDialog
              open={deleting}
              onOpenChange={setDeleting}
              destructive
              title="Delete this collection?"
              confirmLabel="Delete collection"
              description={<>“{collection.name}” is deleted. The videos in it stay in your library.</>}
              onConfirm={async () => {
                await del(`/api/collections/${id}`);
                router.push("/collections");
              }}
            />
          </>
        );
      }}
    </Query>
  );
}

export function PlaylistsView() {
  const result = useApi<{ items: PlaylistRef[] }>("/api/library/playlists");
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  return (
    <>
      <PageHeader
        title="Playlists"
        description="Playlists from your subscribed sources, and playlists you've made."
        actions={<Button onClick={() => setCreating(true)}><Plus aria-hidden="true" /> New playlist</Button>}
      />
      <Query result={result} skeleton={<GridSkeleton count={4} />}>
        {({ items }) => {
          const mine = items.filter((p) => p.kind === "user");
          const source = items.filter((p) => p.kind !== "user");
          if (items.length === 0) {
            return <EmptyState icon={ListVideo} title="No playlists yet" description="Subscribe to a playlist in Sources, or make your own." action={<Button onClick={() => setCreating(true)}>New playlist</Button>} />;
          }
          const grid = (list: PlaylistRef[], label: string) => (
            <ul aria-label={label} className="grid gap-x-4 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
              {list.map((p) => (
                <li key={p.id}><PlaylistCard playlist={p} href={`/playlists/${p.id}`} /></li>
              ))}
            </ul>
          );
          return (
            <div className="space-y-8">
              <section aria-labelledby="pl-mine">
                <h2 id="pl-mine" className="mb-3 text-lg font-semibold tracking-tight">Your playlists</h2>
                {mine.length ? grid(mine, "Your playlists") : <p className="text-sm text-muted-foreground">You haven't made a playlist yet.</p>}
              </section>
              <section aria-labelledby="pl-src">
                <h2 id="pl-src" className="mb-3 text-lg font-semibold tracking-tight">From your sources</h2>
                {source.length ? grid(source, "Source playlists") : <p className="text-sm text-muted-foreground">No playlist sources yet.</p>}
              </section>
            </div>
          );
        }}
      </Query>
      <CollectionFormDialog open={creating} onOpenChange={setCreating} kind="playlist" onSaved={(c) => (c.id ? router.push(`/playlists/${c.id}`) : void result.mutate())} />
    </>
  );
}

export function PlaylistDetailView({ id }: { id: string }) {
  const result = useApi<{ playlist: { id: string; name: string; kind: string }; items: MediaSummary[] }>(`/api/library/playlists/${id}`);
  return (
    <Query result={result} skeleton={<GridSkeleton />}>
      {({ playlist, items }) => {
        const first = items.find((m) => m.playable);
        return (
          <>
            <PageHeader
              title={playlist.name}
              description={`${items.length} ${items.length === 1 ? "video" : "videos"}, in playlist order. ${items.filter((m) => m.playable).length} downloaded.`}
              actions={
                first ? (
                  <Button asChild><Link href={`/watch/${first.id}?list=${id}`}><Play aria-hidden="true" /> Play all</Link></Button>
                ) : (
                  <Button disabled>Play all</Button>
                )
              }
            />
            {items.length === 0 ? (
              <EmptyState icon={ListVideo} title="This playlist is empty" />
            ) : (
              <ol className="grid gap-x-4 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]" aria-label={`Videos in ${playlist.name}`}>
                {items.map((m, i) => (
                  <li key={m.id} className="min-w-0">
                    <p className="mb-1 text-xs tabular-nums text-muted-foreground"><span className="sr-only">Number </span>{i + 1}</p>
                    <MediaCard media={m} listId={id} />
                  </li>
                ))}
              </ol>
            )}
          </>
        );
      }}
    </Query>
  );
}

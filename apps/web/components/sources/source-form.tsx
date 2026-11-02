"use client";

import * as React from "react";
import { ApiError, api, errorMessage, fieldErrors, post, useApi } from "@/lib/api";
import type {
  DiscoveryMode, DownloadOptions, PolicyChangeResult, Priority, Resolution, RetentionMode, ScheduleKind, Source, StorageOverview,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FormError, FormSection, ToggleRow } from "@/components/common/form";
import { PRIORITIES, priorityDescription, priorityLabel } from "@/lib/priority";
import { AdvancedSettings, useAdvancedDisclosure } from "@/components/common/advanced-settings";
import { PolicyChangeView } from "@/components/storage/simulation-view";

interface IdentifyResult { ok: boolean; platform: string; type: string; externalId: string; canonicalUrl: string }

const RETENTION: { value: RetentionMode; label: string; help: string }[] = [
  { value: "all", label: "Keep everything", help: "Every downloaded item stays until you remove it or space runs out." },
  { value: "latest_n", label: "Latest N videos", help: "Protect the newest N videos. Older ones can be removed when space is needed." },
  { value: "last_days", label: "Last N days", help: "Protect videos published within N days." },
  { value: "quota", label: "Storage quota", help: "Protect the newest videos until their total size reaches the quota." },
  { value: "rolling", label: "Rolling window", help: "Like latest N, and older videos are removed on a schedule, not just when space is short." },
  { value: "prefer_unwatched", label: "Prefer unwatched", help: "Protect unwatched videos. Watched ones can be removed first." },
  { value: "none", label: "Keep nothing", help: "Nothing is protected. Videos can be removed whenever space is needed." },
];

const SCHEDULES: { value: ScheduleKind; label: string }[] = [
  { value: "once", label: "Once" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "cron", label: "Custom cron" },
  { value: "manual", label: "Manual only" },
];

const csv = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
/** The shared zod schemas accept absent optional fields but not null, so empty means omitted. */
const numOrUndef = (v: string) => (v.trim() === "" ? undefined : Number(v));
const GB = 1024 ** 3;
/** Error keys that belong to fields inside "Advanced settings". */
const ADVANCED_KEYS = ["cron", "filters", "downloadOptions", "discovery", "automaticEviction", "autoDownload", "volumeId"] as const;

export function SourceForm({
  source,
  onSaved,
  onCancel,
}: {
  source?: Source;
  onSaved: (s: Source) => void;
  onCancel: () => void;
}) {
  const editing = !!source;
  const volumes = useApi<StorageOverview>("/api/storage");
  const f = source?.filters ?? {};
  const dl: Partial<DownloadOptions> = source?.downloadOptions ?? {};

  const [input, setInput] = React.useState(source?.url ?? "");
  const [kind, setKind] = React.useState<"url" | "search">(source?.type === "search" ? "search" : "url");
  const [query, setQuery] = React.useState(source?.query ?? "");
  const [name, setName] = React.useState(source?.name ?? "");
  const [priority, setPriority] = React.useState<Priority>(source?.priority ?? "P1");
  const [retMode, setRetMode] = React.useState<RetentionMode>(source?.retention.mode ?? "all");
  const [retCount, setRetCount] = React.useState(String(source?.retention.count ?? 20));
  const [retDays, setRetDays] = React.useState(String(source?.retention.days ?? 30));
  const [retQuotaGb, setRetQuotaGb] = React.useState(String(source?.retention.quotaBytes ? Math.round(source.retention.quotaBytes / GB) : 50));
  const [autoEvict, setAutoEvict] = React.useState(source?.automaticEviction ?? true);
  const [autoDownload, setAutoDownload] = React.useState(source?.autoDownload ?? true);
  const [schedKind, setSchedKind] = React.useState<ScheduleKind>(source?.schedule.kind ?? "daily");
  const [cron, setCron] = React.useState(source?.schedule.cron ?? "0 3 * * *");

  const [maxAge, setMaxAge] = React.useState(String(f.maxAgeDays ?? ""));
  const [minDur, setMinDur] = React.useState(f.minDurationSec ? String(Math.round(f.minDurationSec / 60)) : "");
  const [maxDur, setMaxDur] = React.useState(f.maxDurationSec ? String(Math.round(f.maxDurationSec / 60)) : "");
  const [maxHist, setMaxHist] = React.useState(String(f.maxHistorical ?? ""));
  const [maxNew, setMaxNew] = React.useState(String(f.maxNewPerRun ?? ""));
  const [shorts, setShorts] = React.useState(f.includeShorts ?? false);
  const [lives, setLives] = React.useState(f.includeLive ?? false);
  const [required, setRequired] = React.useState((f.requiredKeywords ?? []).join(", "));
  const [excluded, setExcluded] = React.useState((f.excludedKeywords ?? []).join(", "));
  const [lang, setLang] = React.useState(f.preferredLanguage ?? "");

  const [res, setRes] = React.useState(String(dl.resolution ?? ""));
  const [audioOnly, setAudioOnly] = React.useState(dl.audioOnly ?? false);
  const [subs, setSubs] = React.useState(dl.subtitles?.enabled ?? true);
  const [subLangs, setSubLangs] = React.useState((dl.subtitles?.languages ?? ["en"]).join(", "));
  const [subAuto, setSubAuto] = React.useState(dl.subtitles?.auto ?? false);

  const [discOn, setDiscOn] = React.useState(source?.discovery.enabled ?? false);
  const [discDepth, setDiscDepth] = React.useState(String(source?.discovery.depth ?? 1));
  const [discMode, setDiscMode] = React.useState<DiscoveryMode>(source?.discovery.mode ?? "approval");
  const [discMax, setDiscMax] = React.useState(String(source?.discovery.maxRecommendations ?? 10));
  const [volumeId, setVolumeId] = React.useState(source?.volumeId ?? "");

  const [identified, setIdentified] = React.useState<IdentifyResult | null>(null);
  const [identifyError, setIdentifyError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const adv = useAdvancedDisclosure(ADVANCED_KEYS);
  const [sim, setSim] = React.useState<PolicyChangeResult | null>(null);
  const [simBusy, setSimBusy] = React.useState(false);
  const [simError, setSimError] = React.useState<string | null>(null);

  // Live identify, debounced.
  React.useEffect(() => {
    if (editing || kind !== "url") return;
    const v = input.trim();
    setIdentified(null);
    setIdentifyError(null);
    if (v.length < 3) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await api<IdentifyResult>("/api/sources/identify", { method: "POST", body: { input: v }, signal: ctrl.signal, noRedirect: true });
        setIdentified(r);
      } catch (e) {
        if (e instanceof DOMException) return;
        setIdentifyError(e instanceof ApiError && e.status === 400 ? "This isn't a channel, playlist or video link that NoConMedia recognises. Check the address and try again." : errorMessage(e));
      }
    }, 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [input, kind, editing]);

  function retention() {
    const r: Source["retention"] = { mode: retMode };
    if (retMode === "latest_n" || retMode === "rolling") r.count = Number(retCount);
    if (retMode === "last_days") r.days = Number(retDays);
    if (retMode === "quota") r.quotaBytes = Math.round(Number(retQuotaGb) * GB);
    return r;
  }

  function buildBody() {
    const body: Record<string, unknown> = {
      name: name.trim() || undefined,
      priority,
      retention: retention(),
      automaticEviction: autoEvict,
      autoDownload,
      schedule: schedKind === "cron" ? { kind: "cron", cron: cron.trim() } : { kind: schedKind },
      filters: {
        maxAgeDays: numOrUndef(maxAge),
        minDurationSec: minDur ? Math.round(Number(minDur) * 60) : undefined,
        maxDurationSec: maxDur ? Math.round(Number(maxDur) * 60) : undefined,
        maxHistorical: numOrUndef(maxHist),
        maxNewPerRun: numOrUndef(maxNew),
        includeShorts: shorts,
        includeLive: lives,
        requiredKeywords: csv(required),
        excludedKeywords: csv(excluded),
        preferredLanguage: lang.trim() || undefined,
      },
      downloadOptions: {
        resolution: res ? (Number(res) as Resolution) : undefined,
        audioOnly,
        subtitles: { enabled: subs, languages: csv(subLangs), auto: subAuto },
      },
      discovery: { enabled: discOn, depth: Number(discDepth), mode: discMode, maxRecommendations: Number(discMax) },
      volumeId: volumeId || null,
    };
    if (!editing) {
      if (kind === "search") {
        body.type = "search";
        body.query = query.trim();
      } else {
        body.input = input.trim();
      }
    } else if (source?.type === "search") {
      body.query = query.trim();
    }
    return body;
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!editing && kind === "url" && !input.trim()) e.input = "Enter a channel, playlist or video address.";
    if (kind === "search" && !query.trim()) e.query = "Enter what to search for.";
    if ((retMode === "latest_n" || retMode === "rolling") && !(Number(retCount) >= 1)) e.retCount = "Enter a number of 1 or more.";
    if (retMode === "last_days" && !(Number(retDays) >= 1)) e.retDays = "Enter a number of days, 1 or more.";
    if (retMode === "quota" && !(Number(retQuotaGb) > 0)) e.retQuota = "Enter a size in GB above 0.";
    if (schedKind === "cron" && cron.trim().split(/\s+/).length < 5) e.cron = "Use five fields, for example 0 3 * * * for 03:00 daily.";
    return e;
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) { adv.reveal(e); return; }
    setBusy(true);
    try {
      const body = buildBody();
      const out = editing
        ? await api<{ source: Source }>(`/api/sources/${source!.id}`, { method: "PATCH", body })
        : await post<{ source: Source }>("/api/sources", body);
      onSaved(out.source);
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      setFormError(errorMessage(err));
      adv.reveal(fe);
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    if (!source) return;
    setSimBusy(true);
    setSimError(null);
    try {
      setSim(await post<PolicyChangeResult>("/api/storage/simulate", { sourceId: source.id, retention: retention() }));
    } catch (e) {
      setSimError(errorMessage(e));
    } finally {
      setSimBusy(false);
    }
  }

  // Advanced values that differ from what a new source starts with.
  const changed = [
    !autoEvict,
    !autoDownload,
    schedKind === "cron" && cron.trim() !== "0 3 * * *",
    [maxAge, minDur, maxDur, maxHist, maxNew, required, excluded, lang].some((v) => v.trim() !== ""),
    shorts, lives, audioOnly,
    subs && (subLangs.trim() !== "en" || subAuto),
    discOn,
    discOn && (discDepth !== "1" || discMode !== "approval" || discMax !== "10"),
    volumeId !== "",
  ].filter(Boolean).length;

  const retInfo = RETENTION.find((r) => r.value === retMode)!;

  return (
    <form ref={adv.formRef} onSubmit={submit} noValidate className="space-y-5">
      <FormError message={formError} />

      {!editing ? (
        <FormSection title="What to follow">
          <Field id="src-kind" label="Source kind">
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as "url" | "search")}>
                <option value="url">Channel, playlist or video address</option>
                <option value="search">Search query</option>
              </Select>
            )}
          </Field>
          {kind === "url" ? (
            <Field id="src-input" label="Address or handle" hint="For example https://www.youtube.com/@name, a playlist link, or @name." error={errors.input}>
              {(p) => <Input {...p} value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
          ) : (
            <Field id="src-query" label="Search query" hint="New results for this search are added each time the source runs." error={errors.query}>
              {(p) => <Input {...p} value={query} onChange={(e) => setQuery(e.target.value)} />}
            </Field>
          )}
          <div aria-live="polite" className="text-sm">
            {identified ? <p className="text-success">Recognised a {identified.platform} {identified.type}: {identified.canonicalUrl}</p> : null}
            {identifyError ? <p className="text-destructive">{identifyError}</p> : null}
          </div>
        </FormSection>
      ) : source?.type === "search" ? (
        <Field id="src-query" label="Search query" error={errors.query}>
          {(p) => <Input {...p} value={query} onChange={(e) => setQuery(e.target.value)} />}
        </Field>
      ) : null}

      <Field id="src-name" label="Name" optional hint="Leave blank to use the name from the platform." error={errors.name}>
        {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>

      <FormSection title="Priority" description="Priority decides what is removed first when the drive fills up.">
        <fieldset className="space-y-2">
          <legend className="sr-only">Priority</legend>
          {PRIORITIES.map((p) => (
            <label key={p} className="flex cursor-pointer items-start gap-3 rounded-md border p-2 has-[:checked]:border-primary">
              <input type="radio" name="priority" value={p} checked={priority === p} onChange={() => setPriority(p)} className="mt-1 size-4 accent-[var(--primary)]" />
              <span>
                <span className="block text-sm font-medium">{priorityLabel(p)}</span>
                <span className="block text-xs text-muted-foreground">{priorityDescription(p)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </FormSection>

      <FormSection title="Retention" description="Retention decides which downloaded videos are protected from removal.">
        <Field id="ret-mode" label="Retention mode" hint={retInfo.help}>
          {(p) => (
            <Select {...p} value={retMode} onChange={(e) => setRetMode(e.target.value as RetentionMode)}>
              {RETENTION.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
          )}
        </Field>
        {retMode === "latest_n" || retMode === "rolling" ? (
          <Field id="ret-count" label="Number of videos" error={errors.retCount}>
            {(p) => <Input {...p} type="number" min={1} value={retCount} onChange={(e) => setRetCount(e.target.value)} />}
          </Field>
        ) : null}
        {retMode === "last_days" ? (
          <Field id="ret-days" label="Days" error={errors.retDays}>
            {(p) => <Input {...p} type="number" min={1} value={retDays} onChange={(e) => setRetDays(e.target.value)} />}
          </Field>
        ) : null}
        {retMode === "quota" ? (
          <Field id="ret-quota" label="Quota (GB)" error={errors.retQuota}>
            {(p) => <Input {...p} type="number" min={1} value={retQuotaGb} onChange={(e) => setRetQuotaGb(e.target.value)} />}
          </Field>
        ) : null}
      </FormSection>

      <FormSection title="Schedule">
        <Field id="sched" label="How often to check for new videos">
          {(p) => (
            <Select {...p} value={schedKind} onChange={(e) => { const k = e.target.value as ScheduleKind; setSchedKind(k); if (k === "cron") adv.setOpen(true); }}>
              {SCHEDULES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          )}
        </Field>
        {schedKind === "cron" ? <p className="text-xs text-muted-foreground">Set the cron expression under Advanced settings.</p> : null}
        {schedKind === "manual" ? <p className="text-xs text-muted-foreground">The source only runs when you choose Sync now.</p> : null}
      </FormSection>

      <FormSection title="Download options">
        <Field id="d-res" label="Resolution" hint="Leave on the default to use the setting from Settings.">
          {(p) => (
            <Select {...p} value={res} onChange={(e) => setRes(e.target.value)}>
              <option value="">Use the default</option>
              {[2160, 1440, 1080, 720, 480, 360].map((r) => <option key={r} value={r}>{r}p</option>)}
            </Select>
          )}
        </Field>
        <ToggleRow id="d-subs" label="Download subtitles">{(p) => <Switch {...p} checked={subs} onCheckedChange={setSubs} />}</ToggleRow>
      </FormSection>

      <AdvancedSettings open={adv.open} onOpenChange={adv.setOpen} changed={changed}>
        <FormSection title="Retention">
          <ToggleRow id="auto-evict" label="Automatic eviction" description="Allow this source's new downloads to make room by removing lower-priority media. Off means downloads wait for space instead.">
            {(p) => <Switch {...p} checked={autoEvict} onCheckedChange={setAutoEvict} />}
          </ToggleRow>
          {editing ? (
            <div className="space-y-3">
              <Button variant="secondary" onClick={() => void preview()} disabled={simBusy}>{simBusy ? "Calculating…" : "Preview impact"}</Button>
              <p className="text-xs text-muted-foreground">Shows what the retention above would change. Nothing is saved or deleted.</p>
              {simError ? <p role="alert" className="text-sm text-destructive">{simError}</p> : null}
              {sim ? <PolicyChangeView result={sim} /> : null}
            </div>
          ) : null}
        </FormSection>

        <FormSection title="Schedule">
          {schedKind === "cron" ? (
            <Field id="cron" label="Cron expression" hint="Minute, hour, day of month, month, day of week." error={errors.cron}>
              {(p) => <Input {...p} value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" spellCheck={false} />}
            </Field>
          ) : (
            <p className="text-xs text-muted-foreground">Choose Custom cron under Schedule above to set your own times.</p>
          )}
        </FormSection>

        <FormSection title="Downloads">
          <ToggleRow id="auto-download" label="Download new videos automatically" description="When off, new videos from this source are listed but not downloaded until you choose them.">
            {(p) => <Switch {...p} checked={autoDownload} onCheckedChange={setAutoDownload} />}
          </ToggleRow>
        </FormSection>

        <FormSection title="Filters" description="Leave a field empty for no limit.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="f-age" label="Maximum age (days)">{(p) => <Input {...p} type="number" min={1} value={maxAge} onChange={(e) => setMaxAge(e.target.value)} />}</Field>
            <Field id="f-hist" label="Maximum historical videos" hint="How many existing videos to import on the first run.">{(p) => <Input {...p} type="number" min={0} value={maxHist} onChange={(e) => setMaxHist(e.target.value)} />}</Field>
            <Field id="f-min" label="Minimum length (minutes)">{(p) => <Input {...p} type="number" min={0} value={minDur} onChange={(e) => setMinDur(e.target.value)} />}</Field>
            <Field id="f-max" label="Maximum length (minutes)">{(p) => <Input {...p} type="number" min={0} value={maxDur} onChange={(e) => setMaxDur(e.target.value)} />}</Field>
            <Field id="f-new" label="Maximum new videos per run">{(p) => <Input {...p} type="number" min={1} value={maxNew} onChange={(e) => setMaxNew(e.target.value)} />}</Field>
            <Field id="f-lang" label="Preferred language" hint="A language code such as en.">{(p) => <Input {...p} value={lang} onChange={(e) => setLang(e.target.value)} />}</Field>
          </div>
          <Field id="f-req" label="Required keywords" hint="Comma separated. A video's title must contain at least one.">{(p) => <Input {...p} value={required} onChange={(e) => setRequired(e.target.value)} />}</Field>
          <Field id="f-exc" label="Excluded keywords" hint="Comma separated. Videos with any of these in the title are skipped.">{(p) => <Input {...p} value={excluded} onChange={(e) => setExcluded(e.target.value)} />}</Field>
          <ToggleRow id="f-shorts" label="Include Shorts">{(p) => <Checkbox {...p} checked={shorts} onCheckedChange={(v) => setShorts(v === true)} />}</ToggleRow>
          <ToggleRow id="f-live" label="Include livestreams and recordings">{(p) => <Checkbox {...p} checked={lives} onCheckedChange={(v) => setLives(v === true)} />}</ToggleRow>
        </FormSection>

        <FormSection title="Subtitles and audio">
          <ToggleRow id="d-audio" label="Audio only" description="Saves space. Videos play as audio with a still image.">{(p) => <Switch {...p} checked={audioOnly} onCheckedChange={setAudioOnly} />}</ToggleRow>
          {subs ? (
            <>
              <Field id="d-sublang" label="Subtitle languages" hint="Comma separated language codes, for example en, fr.">{(p) => <Input {...p} value={subLangs} onChange={(e) => setSubLangs(e.target.value)} />}</Field>
              <ToggleRow id="d-subauto" label="Include automatic captions" description="Machine-generated captions are less accurate.">{(p) => <Checkbox {...p} checked={subAuto} onCheckedChange={(v) => setSubAuto(v === true)} />}</ToggleRow>
            </>
          ) : <p className="text-xs text-muted-foreground">Turn on Download subtitles above to choose languages.</p>}
        </FormSection>

        <FormSection title="Discovery" description="Find similar channels and videos from this source.">
          <ToggleRow id="disc-on" label="Discover from this source">{(p) => <Switch {...p} checked={discOn} onCheckedChange={setDiscOn} />}</ToggleRow>
          {discOn ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="disc-depth" label="Depth" hint="0 is this source only. 2 follows recommendations of recommendations.">
                {(p) => <Select {...p} value={discDepth} onChange={(e) => setDiscDepth(e.target.value)}><option value="0">0</option><option value="1">1</option><option value="2">2</option></Select>}
              </Field>
              <Field id="disc-mode" label="Mode" hint="Suggest for approval queues items until you approve them.">
                {(p) => <Select {...p} value={discMode} onChange={(e) => setDiscMode(e.target.value as DiscoveryMode)}><option value="approval">Suggest for approval</option><option value="auto">Download automatically</option><option value="discovery_only">Catalogue only, no downloads</option></Select>}
              </Field>
              <Field id="disc-max" label="Maximum recommendations">{(p) => <Input {...p} type="number" min={1} value={discMax} onChange={(e) => setDiscMax(e.target.value)} />}</Field>
            </div>
          ) : null}
        </FormSection>

        <Field id="vol" label="Target volume" hint="Where this source's media is stored.">
          {(p) => (
            <Select {...p} value={volumeId} onChange={(e) => setVolumeId(e.target.value)}>
              <option value="">Default volume</option>
              {volumes.data?.volumes.map((v) => <option key={v.id} value={v.id}>{v.name}{v.isOnline ? "" : " (offline)"}</option>)}
            </Select>
          )}
        </Field>
      </AdvancedSettings>

      <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 border-t bg-popover p-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Add source"}</Button>
      </div>
    </form>
  );
}

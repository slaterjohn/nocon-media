"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Film, RefreshCw, XCircle } from "lucide-react";
import { ApiError, api, errorMessage, fieldErrors, get, post } from "@/lib/api";
import type { SetupChecks, SetupStatus, StorageValidation } from "@/lib/types";
import { formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Field, FormError, ToggleRow } from "@/components/common/form";
import { LoadingSkeleton } from "@/components/layout/states";
import { ThemeToggle } from "@/components/layout/theme";

const STEPS = [
  "Administrator",
  "System checks",
  "Storage",
  "Profile",
  "Quality",
  "Thresholds",
  "External players",
  "First source",
  "Finish",
];

const RESOLUTIONS = [2160, 1440, 1080, 720, 480, 360];

interface IdentifyResult {
  ok: boolean;
  platform: string;
  type: string;
  externalId: string;
  canonicalUrl: string;
}

export default function SetupPage() {
  const [step, setStep] = React.useState<number | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [storageSaved, setStorageSaved] = React.useState<{ path: string; name: string } | null>(null);
  const [defaultMediaPath, setDefaultMediaPath] = React.useState("/media");

  const [profile, setProfile] = React.useState<"lightweight" | "standard">("lightweight");
  const [resolution, setResolution] = React.useState(1080);
  const [soft, setSoft] = React.useState(85);
  const [minFree, setMinFree] = React.useState(5);
  const [xtream, setXtream] = React.useState(true);
  const [m3u, setM3u] = React.useState(true);
  const [sourceInput, setSourceInput] = React.useState("");
  const [sourceNote, setSourceNote] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const s = await get<SetupStatus>("/api/setup/status");
      if (s.defaultMediaPath) setDefaultMediaPath(s.defaultMediaPath);
      if (s.setupComplete) {
        window.location.replace("/");
        return;
      }
      if (!s.hasAdmin && !s.steps.admin) setStep(0);
      else if (!s.steps.storage) setStep(1);
      else if (!s.steps.profile) setStep(3);
      else setStep(8);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  const next = () => setStep((s) => Math.min((s ?? 0) + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max((s ?? 0) - 1, 0));

  return (
    <div className="min-h-dvh p-4">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <main id="main" className="mx-auto w-full max-w-2xl py-6">
        <div className="mb-6 flex items-center gap-2 text-xl font-semibold">
          <Film className="size-6 text-primary" aria-hidden="true" /> NoConMedia setup
        </div>

        {step !== null && !done ? (
          <nav aria-label="Setup progress" className="mb-4">
            <p className="text-sm text-muted-foreground">
              Step {step + 1} of {STEPS.length}: <span className="font-medium text-foreground">{STEPS[step]}</span>
            </p>
            <ol className="mt-2 flex gap-1" aria-hidden="true">
              {STEPS.map((_, i) => (
                <li key={i} className={`h-1.5 flex-1 rounded-full ${i <= step ? "bg-primary" : "bg-secondary"}`} />
              ))}
            </ol>
          </nav>
        ) : null}

        {loadError ? (
          <div role="alert" className="space-y-2 rounded-lg border border-destructive/60 p-4">
            <p className="font-medium">Couldn't reach the server</p>
            <p className="text-sm">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" /> Try again
            </Button>
          </div>
        ) : step === null ? (
          <LoadingSkeleton variant="page" label="Loading setup" />
        ) : done ? (
          <Summary
            profile={profile}
            resolution={resolution}
            soft={soft}
            minFree={minFree}
            xtream={xtream}
            m3u={m3u}
            storage={storageSaved}
            sourceNote={sourceNote}
          />
        ) : step === 0 ? (
          <AdminStep onDone={next} />
        ) : step === 1 ? (
          <ChecksStep onNext={next} />
        ) : step === 2 ? (
          <StorageStep defaultPath={defaultMediaPath} onBack={back} onSaved={(v) => { setStorageSaved(v); next(); }} />
        ) : step === 3 ? (
          <ChoiceStep
            title="Deployment profile"
            description="This sets how many downloads and conversions run at once."
            onBack={back}
            onNext={next}
          >
            <fieldset className="space-y-3">
              <legend className="sr-only">Deployment profile</legend>
              {(
                [
                  ["lightweight", "Lightweight", "Recommended for a Raspberry Pi. One download and one conversion at a time, and no on-demand HLS."],
                  ["standard", "Standard", "For a desktop, NAS or small server. Several downloads in parallel."],
                ] as const
              ).map(([value, label, desc]) => (
                <label key={value} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary">
                  <input type="radio" name="profile" value={value} checked={profile === value} onChange={() => setProfile(value)} className="mt-1 size-4 accent-[var(--primary)]" />
                  <span>
                    <span className="block font-medium">{label}</span>
                    <span className="block text-sm text-muted-foreground">{desc}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </ChoiceStep>
        ) : step === 4 ? (
          <ChoiceStep title="Default quality" description="New sources download at this resolution or the closest one below it. Each source can override it." onBack={back} onNext={next}>
            <Field id="resolution" label="Default resolution" hint="Higher resolutions use much more disk. 1080p suits most screens.">
              {(p) => (
                <Select {...p} value={resolution} onChange={(e) => setResolution(Number(e.target.value))}>
                  {RESOLUTIONS.map((r) => (
                    <option key={r} value={r}>{r}p{r === 1080 ? " (recommended)" : ""}</option>
                  ))}
                </Select>
              )}
            </Field>
          </ChoiceStep>
        ) : step === 5 ? (
          <ThresholdStep soft={soft} minFree={minFree} setSoft={setSoft} setMinFree={setMinFree} onBack={back} onNext={next} />
        ) : step === 6 ? (
          <ChoiceStep title="External players" description="Let apps such as UHF, VLC or Jellyfin-style clients stream from this server. You create a login for each player later." onBack={back} onNext={next}>
            <div className="space-y-4">
              <ToggleRow id="xtream" label="Xtream Codes API" description="For apps with an Xtream login option, such as UHF.">
                {(p) => <Switch {...p} checked={xtream} onCheckedChange={setXtream} />}
              </ToggleRow>
              <ToggleRow id="m3u" label="M3U playlist" description="A playlist URL for apps without Xtream support.">
                {(p) => <Switch {...p} checked={m3u} onCheckedChange={setM3u} />}
              </ToggleRow>
            </div>
          </ChoiceStep>
        ) : step === 7 ? (
          <SourceStep value={sourceInput} onChange={setSourceInput} onBack={back} onNext={next} setNote={setSourceNote} />
        ) : (
          <FinishStep
            onBack={back}
            settings={{ profile, defaultResolution: resolution, softThreshold: soft, minFreePercent: minFree, enableXtream: xtream, enableM3u: m3u }}
            sourceInput={sourceInput}
            onDone={(note) => {
              setSourceNote(note);
              setDone(true);
            }}
          />
        )}
      </main>
    </div>
  );
}

function StepCard({ title, description, children, footer }: { title: string; description?: string; children: React.ReactNode; footer: React.ReactNode }) {
  const ref = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => ref.current?.focus(), []);
  return (
    <Card>
      <CardHeader>
        <div>
          <h1 ref={ref} tabIndex={-1} className="text-xl font-semibold leading-tight outline-none">{title}</h1>
        </div>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {children}
        <div className="flex flex-wrap justify-between gap-2 pt-2">{footer}</div>
      </CardContent>
    </Card>
  );
}

function ChoiceStep({ title, description, children, onBack, onNext }: { title: string; description: string; children: React.ReactNode; onBack: () => void; onNext: () => void }) {
  return (
    <StepCard
      title={title}
      description={description}
      footer={
        <>
          <Button variant="outline" onClick={onBack}>Back</Button>
          <Button onClick={onNext}>Continue</Button>
        </>
      }
    >
      {children}
    </StepCard>
  );
}

function AdminStep({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = React.useState("admin");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (username.trim().length < 3) fe.username = "Use at least 3 characters.";
    if (password.length < 10) fe.password = "Use at least 10 characters.";
    if (confirm !== password) fe.confirm = "The passwords don't match.";
    setErrors(fe);
    setError(null);
    if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      await api("/api/setup/admin", { method: "POST", body: { username: username.trim(), password }, noRedirect: true });
      onDone();
    } catch (err) {
      const f = fieldErrors(err);
      if (Object.keys(f).length) setErrors(f);
      setError(err instanceof ApiError && err.status === 409 ? "An administrator already exists. Sign in instead." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <StepCard
        title="Create the administrator"
        description="This account manages sources, downloads and storage. You can change the password later in Settings."
        footer={
          <>
            <Button variant="link" asChild className="px-0"><Link href="/login">I already have an account</Link></Button>
            <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
          </>
        }
      >
        <FormError message={error} />
        <Field id="admin-username" label="Username" error={errors.username}>
          {(p) => <Input {...p} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />}
        </Field>
        <Field id="admin-password" label="Password" hint="At least 10 characters." error={errors.password}>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Field id="admin-confirm" label="Confirm password" error={errors.confirm}>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
      </StepCard>
    </form>
  );
}

function CheckRow({ ok, warn, label, detail }: { ok: boolean; warn?: boolean; label: string; detail?: string }) {
  const Icon = ok ? CheckCircle2 : warn ? AlertTriangle : XCircle;
  const cls = ok ? "text-success" : warn ? "text-warning" : "text-destructive";
  return (
    <li className="flex items-start gap-3 rounded-md border p-3">
      <Icon className={`mt-0.5 size-5 shrink-0 ${cls}`} aria-hidden="true" />
      <div>
        <p className="font-medium">{label}: {ok ? "working" : warn ? "not running" : "failed"}</p>
        {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
      </div>
    </li>
  );
}

function ChecksStep({ onNext }: { onNext: () => void }) {
  const [checks, setChecks] = React.useState<SetupChecks | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const run = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setChecks(await get<SetupChecks>("/api/setup/checks"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);
  React.useEffect(() => {
    void run();
  }, [run]);
  const blocked = !checks || !checks.database.ok || !checks.redis.ok;
  return (
    <StepCard
      title="System checks"
      description="NoConMedia needs the database and Redis. The worker downloads media, but you can finish setup without it."
      footer={
        <>
          <Button variant="outline" onClick={() => void run()} disabled={busy}><RefreshCw aria-hidden="true" /> {busy ? "Checking…" : "Check again"}</Button>
          <Button onClick={onNext} disabled={blocked}>Continue</Button>
        </>
      }
    >
      <div aria-live="polite">
        <FormError message={error} />
        {checks ? (
          <ul className="space-y-2">
            <CheckRow ok={checks.database.ok} label="Database" detail={checks.database.ok ? undefined : checks.database.message ?? "Check the postgres container and DATABASE_URL, then check again."} />
            <CheckRow ok={checks.redis.ok} label="Redis" detail={checks.redis.ok ? undefined : "Check the redis container and REDIS_URL, then check again."} />
            <CheckRow ok={checks.worker.ok} warn label="Worker" detail={checks.worker.ok ? undefined : "Downloads won't start until the worker is running. You can continue and start it later."} />
          </ul>
        ) : !error ? (
          <LoadingSkeleton rows={3} label="Running checks" />
        ) : null}
      </div>
    </StepCard>
  );
}

function StorageStep({ defaultPath, onBack, onSaved }: { defaultPath: string; onBack: () => void; onSaved: (v: { path: string; name: string }) => void }) {
  const [path, setPath] = React.useState(defaultPath);
  const [name, setName] = React.useState("Main library");
  const [result, setResult] = React.useState<StorageValidation | null>(null);
  const [validatedPath, setValidatedPath] = React.useState<string | null>(null);
  const [ack, setAck] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<"validate" | "save" | null>(null);

  async function validate() {
    setBusy("validate");
    setError(null);
    setResult(null);
    setAck(false);
    try {
      const r = await post<StorageValidation>("/api/setup/storage/validate", { path: path.trim(), name: name.trim() || undefined });
      setResult(r);
      setValidatedPath(path.trim());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    setBusy("save");
    setError(null);
    try {
      await post("/api/setup/storage", { path: path.trim(), name: name.trim() || "Main library" });
      onSaved({ path: path.trim(), name: name.trim() });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }
  const stale = result && validatedPath !== path.trim();
  const needsAck = !!result?.onRootFs;
  const canConfirm = !!result && !stale && result.ok && result.errors.length === 0 && (!needsAck || ack);

  return (
    <StepCard
      title="Storage location"
      description="Choose the folder where media is kept. For an external or network drive, mount it first, then enter the mounted path."
      footer={
        <>
          <Button variant="outline" onClick={onBack}>Back</Button>
          <Button onClick={() => void save()} disabled={!canConfirm || busy !== null}>{busy === "save" ? "Saving…" : "Confirm storage"}</Button>
        </>
      }
    >
      <FormError message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="storage-path" label="Folder path" hint={`The path inside the container. The default is ${defaultPath}.`}>
          {(p) => <Input {...p} value={path} onChange={(e) => setPath(e.target.value)} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field id="storage-name" label="Volume name">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
      </div>
      <Button variant="secondary" onClick={() => void validate()} disabled={busy !== null || !path.trim()}>
        {busy === "validate" ? "Validating…" : "Validate"}
      </Button>

      <div aria-live="polite">
        {result ? (
          <div className="space-y-3 rounded-lg border p-3 text-sm">
            {stale ? <p className="text-warning">The path changed. Validate again before confirming.</p> : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Exists</dt><dd>{result.exists ? "Yes" : "No"}</dd>
              <dt className="text-muted-foreground">Writable</dt><dd>{result.writable ? "Yes" : "No"}</dd>
              <dt className="text-muted-foreground">Mount point</dt><dd>{result.mount ? result.mount.mountPoint : "Not a separate mount"}</dd>
              <dt className="text-muted-foreground">Filesystem</dt><dd>{result.mount ? `${result.mount.fsType} (${result.mount.source})` : "Unknown"}</dd>
              <dt className="text-muted-foreground">Capacity</dt><dd>{formatBytes(result.totalBytes)}</dd>
              <dt className="text-muted-foreground">Free</dt><dd>{formatBytes(result.freeBytes)}</dd>
              {result.existingMarker ? (<><dt className="text-muted-foreground">Existing library</dt><dd>{result.existingMarker.name} (will be reused)</dd></>) : null}
            </dl>
            {result.onRootFs ? (
              <p className="flex gap-2 text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />This looks like the container's own filesystem. Is the drive mounted? Media saved here is lost if the container is recreated.</p>
            ) : null}
            {result.warnings.length ? (
              <ul className="space-y-1">{result.warnings.map((w) => (<li key={w} className="flex gap-2 text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{w}</li>))}</ul>
            ) : null}
            {result.errors.length ? (
              <ul role="alert" className="space-y-1">{result.errors.map((w) => (<li key={w} className="flex gap-2 text-destructive"><XCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{w}</li>))}</ul>
            ) : null}
            {!result.errors.length && result.ok && !result.onRootFs ? (
              <p className="flex gap-2 text-success"><CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />This location can be used.</p>
            ) : null}
            {needsAck && !result.errors.length ? (
              <div className="flex items-center gap-2">
                <Checkbox id="ack-rootfs" checked={ack} onCheckedChange={(v) => setAck(v === true)} />
                <label htmlFor="ack-rootfs">I'm happy to store media on this filesystem.</label>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </StepCard>
  );
}

function ThresholdStep(props: { soft: number; minFree: number; setSoft: (n: number) => void; setMinFree: (n: number) => void; onBack: () => void; onNext: () => void }) {
  const { soft, minFree } = props;
  const errors: Record<string, string> = {};
  if (!(soft >= 50 && soft <= 99)) errors.soft = "Enter a number from 50 to 99.";
  if (!(minFree >= 1 && minFree <= 50)) errors.minFree = "Enter a number from 1 to 50.";
  if (!errors.soft && !errors.minFree && soft > 100 - minFree) errors.soft = `The soft limit can't be above ${100 - minFree}%, which leaves ${minFree}% free.`;
  const ok = Object.keys(errors).length === 0;
  return (
    <StepCard
      title="Storage thresholds"
      description="These keep the drive from filling up. When space is short, NoConMedia removes the lowest-priority downloads first."
      footer={
        <>
          <Button variant="outline" onClick={props.onBack}>Back</Button>
          <Button onClick={props.onNext} disabled={!ok}>Continue</Button>
        </>
      }
    >
      <Field id="soft" label="Soft limit (% used)" hint="Above this, Spare media is cleaned up in the background. Default 85." error={errors.soft}>
        {(p) => <Input {...p} type="number" inputMode="numeric" min={50} max={99} value={soft} onChange={(e) => props.setSoft(Number(e.target.value))} />}
      </Field>
      <Field id="minfree" label="Minimum free space (%)" hint="New downloads stop before free space drops below this, unless older media can be removed. Default 5." error={errors.minFree}>
        {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={50} value={minFree} onChange={(e) => props.setMinFree(Number(e.target.value))} />}
      </Field>
    </StepCard>
  );
}

function SourceStep({ value, onChange, onBack, onNext, setNote }: { value: string; onChange: (v: string) => void; onBack: () => void; onNext: () => void; setNote: (n: string | null) => void }) {
  const [info, setInfo] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  async function check() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const r = await api<IdentifyResult>("/api/sources/identify", { method: "POST", body: { input: value.trim() }, noRedirect: true });
      setInfo(`Recognised a ${r.platform} ${r.type}: ${r.canonicalUrl}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "setup_required") {
        setInfo("This can only be checked once setup is finished. The source is added at the end.");
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <StepCard
      title="First source (optional)"
      description="Paste a YouTube channel, playlist or video URL, or a handle such as @name. You can skip this and add sources later."
      footer={
        <>
          <Button variant="outline" onClick={onBack}>Back</Button>
          <Button onClick={() => { setNote(null); onNext(); }}>{value.trim() ? "Continue" : "Skip"}</Button>
        </>
      }
    >
      <Field id="first-source" label="Channel, playlist or video" optional error={error}>
        {(p) => <Input {...p} value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://www.youtube.com/@example" autoComplete="off" />}
      </Field>
      <div aria-live="polite">{info ? <p className="text-sm text-success">{info}</p> : null}</div>
      <Button variant="secondary" onClick={() => void check()} disabled={busy || !value.trim()}>{busy ? "Checking…" : "Check this source"}</Button>
      <p className="text-xs text-muted-foreground">The source is added with the default policy: priority Keep, keep everything, automatic eviction on, checked daily.</p>
    </StepCard>
  );
}

function FinishStep({ onBack, settings, sourceInput, onDone }: { onBack: () => void; settings: Record<string, unknown> & { profile: string; defaultResolution: number; softThreshold: number; minFreePercent: number; enableXtream: boolean; enableM3u: boolean }; sourceInput: string; onDone: (note: string | null) => void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/setup/complete", { method: "POST", body: settings, noRedirect: true });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    let note: string | null = null;
    if (sourceInput.trim()) {
      try {
        await post("/api/sources/identify", { input: sourceInput.trim() });
        await post("/api/sources", { input: sourceInput.trim(), priority: "P1", retention: { mode: "all" }, automaticEviction: true });
        note = `Added source: ${sourceInput.trim()}`;
      } catch (e) {
        note = `Setup is finished, but the source wasn't added: ${errorMessage(e)} Add it from Sources.`;
      }
    }
    onDone(note);
  }
  return (
    <StepCard
      title="Finish setup"
      description="Review your choices, then finish. You can change all of these later in Settings."
      footer={
        <>
          <Button variant="outline" onClick={onBack} disabled={busy}>Back</Button>
          <Button onClick={() => void finish()} disabled={busy}>{busy ? "Finishing…" : "Finish setup"}</Button>
        </>
      }
    >
      <FormError message={error} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Profile</dt><dd>{settings.profile}</dd>
        <dt className="text-muted-foreground">Default quality</dt><dd>{settings.defaultResolution}p</dd>
        <dt className="text-muted-foreground">Soft limit</dt><dd>{settings.softThreshold}%</dd>
        <dt className="text-muted-foreground">Minimum free</dt><dd>{settings.minFreePercent}%</dd>
        <dt className="text-muted-foreground">Xtream</dt><dd>{settings.enableXtream ? "On" : "Off"}</dd>
        <dt className="text-muted-foreground">M3U</dt><dd>{settings.enableM3u ? "On" : "Off"}</dd>
        <dt className="text-muted-foreground">First source</dt><dd className="break-all">{sourceInput.trim() || "None"}</dd>
      </dl>
    </StepCard>
  );
}

function Summary(props: { profile: string; resolution: number; soft: number; minFree: number; xtream: boolean; m3u: boolean; storage: { path: string; name: string } | null; sourceNote: string | null }) {
  const status = useStatus();
  return (
    <Card>
      <CardHeader>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Setup is finished</h1>
        </div>
        <CardDescription>NoConMedia is ready to use.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="status">{props.sourceNote ? <p className="text-sm">{props.sourceNote}</p> : null}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Storage</dt><dd>{props.storage ? `${props.storage.name} at ${props.storage.path}` : "Configured"}</dd>
          <dt className="text-muted-foreground">Profile</dt><dd>{props.profile}</dd>
          <dt className="text-muted-foreground">Default quality</dt><dd>{props.resolution}p</dd>
          <dt className="text-muted-foreground">Thresholds</dt><dd>Soft {props.soft}%, minimum free {props.minFree}%</dd>
          <dt className="text-muted-foreground">Xtream / M3U</dt><dd>{props.xtream ? "On" : "Off"} / {props.m3u ? "On" : "Off"}</dd>
          <dt className="text-muted-foreground">Server status</dt><dd>{status}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button asChild><Link href="/admin">Open dashboard</Link></Button>
          <Button asChild variant="outline"><Link href="/admin/sources">Add sources</Link></Button>
          <Button asChild variant="outline"><Link href="/admin/clients">Set up external players</Link></Button>
        </div>
      </CardContent>
    </Card>
  );
}

function useStatus() {
  const [s, setS] = React.useState("Checking…");
  React.useEffect(() => {
    get<{ worker: { online: boolean }; storage: { freeBytes: number } }>("/api/dashboard")
      .then((d) => setS(`${d.worker.online ? "Worker running" : "Worker not running yet"}, ${formatBytes(d.storage.freeBytes)} free`))
      .catch(() => setS("Unavailable"));
  }, []);
  return s;
}

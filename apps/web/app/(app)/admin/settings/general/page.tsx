"use client";

import * as React from "react";
import { errorMessage, fieldErrors, useApi } from "@/lib/api";
import type { Settings } from "@/lib/types";
import { useToast } from "@/components/ui/toast";
import { Select } from "@/components/ui/input";
import { Field, FormError } from "@/components/common/form";
import { Query } from "@/components/common/data";
import { SettingsFooter, SettingsPageShell, saveSettingsPatch } from "@/components/settings/settings-page";

function GeneralForm({ initial, onSaved }: { initial: Settings; onSaved: () => void }) {
  const { toast } = useToast();
  const [profile, setProfile] = React.useState(initial.profile);
  const [res, setRes] = React.useState(initial.defaultResolution);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({}); setError(null); setBusy(true);
    try {
      await saveSettingsPatch({ profile, defaultResolution: res });
      toast({ title: "General settings saved", variant: "success" });
      onSaved();
    } catch (err) { setErrors(fieldErrors(err)); setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <FormError message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="s-profile" label="Deployment profile" hint="Lightweight runs one job at a time. The worker picks up a change within a minute." error={errors.profile}>
          {(p) => <Select {...p} value={profile} onChange={(e) => setProfile(e.target.value as Settings["profile"])}><option value="lightweight">Lightweight (Raspberry Pi)</option><option value="standard">Standard</option></Select>}
        </Field>
        <Field id="s-res" label="Default resolution" hint="Used by sources that don't set their own." error={errors.defaultResolution}>
          {(p) => <Select {...p} value={res} onChange={(e) => setRes(Number(e.target.value))}>{[2160, 1440, 1080, 720, 480, 360].map((r) => <option key={r} value={r}>{r}p</option>)}</Select>}
        </Field>
      </div>
      <SettingsFooter busy={busy} />
    </form>
  );
}

export default function GeneralSettingsPage() {
  const result = useApi<Settings>("/api/settings");
  return (
    <SettingsPageShell title="General" description="How much NoConMedia runs at once, and the video quality sources use by default.">
      <Query result={result}>{(s) => <GeneralForm initial={s} onSaved={() => void result.mutate()} />}</Query>
    </SettingsPageShell>
  );
}

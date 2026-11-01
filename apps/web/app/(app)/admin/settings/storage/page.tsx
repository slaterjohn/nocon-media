"use client";

import * as React from "react";
import { errorMessage, fieldErrors, useApi } from "@/lib/api";
import type { Settings } from "@/lib/types";
import { useToast } from "@/components/ui/toast";
import { Input } from "@/components/ui/input";
import { Field, FormError } from "@/components/common/form";
import { Query } from "@/components/common/data";
import { AdvancedSettings, useAdvancedDisclosure } from "@/components/common/advanced-settings";
import { SettingsFooter, SettingsPageShell, saveSettingsPatch } from "@/components/settings/settings-page";

const ADVANCED_KEYS = ["redownloadCooldownDays"] as const;
const DEFAULT_COOLDOWN = 30;

function StorageForm({ initial, onSaved }: { initial: Settings; onSaved: () => void }) {
  const { toast } = useToast();
  const [soft, setSoft] = React.useState(initial.softThreshold);
  const [minFree, setMinFree] = React.useState(initial.minFreePercent);
  const [cooldown, setCooldown] = React.useState(initial.redownloadCooldownDays);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const adv = useAdvancedDisclosure(ADVANCED_KEYS);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!(soft >= 50 && soft <= 99)) fe.softThreshold = "Enter a number from 50 to 99.";
    if (!(minFree >= 1 && minFree <= 50)) fe.minFreePercent = "Enter a number from 1 to 50.";
    if (!fe.softThreshold && !fe.minFreePercent && soft > 100 - minFree) fe.softThreshold = `Must be ${100 - minFree}% or less so ${minFree}% stays free.`;
    if (!(cooldown >= 0)) fe.redownloadCooldownDays = "Enter 0 or more days.";
    setErrors(fe); setError(null);
    if (Object.keys(fe).length) { adv.reveal(fe); return; }
    setBusy(true);
    try {
      await saveSettingsPatch({ softThreshold: soft, minFreePercent: minFree, redownloadCooldownDays: cooldown });
      toast({ title: "Storage settings saved", variant: "success" });
      onSaved();
    } catch (err) { const fe2 = fieldErrors(err); setErrors(fe2); setError(errorMessage(err)); adv.reveal(fe2); } finally { setBusy(false); }
  }

  return (
    <form ref={adv.formRef} onSubmit={submit} noValidate className="space-y-6">
      <FormError message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="s-soft" label="Soft limit (% used)" hint="Above this, Spare media is cleaned up in the background. Applies to every volume." error={errors.softThreshold}>
          {(p) => <Input {...p} type="number" min={50} max={99} value={soft} onChange={(e) => setSoft(Number(e.target.value))} />}
        </Field>
        <Field id="s-min" label="Minimum free space (%)" hint="Downloads stop before free space falls below this." error={errors.minFreePercent}>
          {(p) => <Input {...p} type="number" min={1} max={50} value={minFree} onChange={(e) => setMinFree(Number(e.target.value))} />}
        </Field>
      </div>
      <AdvancedSettings open={adv.open} onOpenChange={adv.setOpen} changed={cooldown !== DEFAULT_COOLDOWN ? 1 : 0}>
        <Field id="s-cool" label="Re-download cooldown (days)" hint="How long an evicted video waits before it can be downloaded again automatically." error={errors.redownloadCooldownDays}>
          {(p) => <Input {...p} type="number" min={0} value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} className="max-w-40" />}
        </Field>
      </AdvancedSettings>
      <SettingsFooter busy={busy} />
    </form>
  );
}

export default function StorageSettingsPage() {
  const result = useApi<Settings>("/api/settings");
  return (
    <SettingsPageShell title="Storage" description="How much disk space NoConMedia leaves free and when it starts removing recommendations.">
      <Query result={result}>{(s) => <StorageForm initial={s} onSaved={() => void result.mutate()} />}</Query>
    </SettingsPageShell>
  );
}

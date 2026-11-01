"use client";

import * as React from "react";
import { errorMessage, useApi } from "@/lib/api";
import type { DiscoveryBudget, DiscoveryMode, Settings } from "@/lib/types";
import { useToast } from "@/components/ui/toast";
import { Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field, FormError, ToggleRow } from "@/components/common/form";
import { Query } from "@/components/common/data";
import { AdvancedSettings, useAdvancedDisclosure } from "@/components/common/advanced-settings";
import { SettingsFooter, SettingsPageShell, saveSettingsPatch } from "@/components/settings/settings-page";

const GB = 1024 ** 3;

const DEFAULT_BUDGET: DiscoveryBudget = {
  enabled: true, mode: "approval", maxDepth: 1, maxDiscovered: 500, maxDownloaded: 50,
  maxStorageBytes: 50 * GB, maxDurationSec: 3600, maxAgeDays: 730, minScore: 0.35, cooldownDays: 30,
};

/** Form state is strings so inputs can be empty while typing. */
interface BudgetDraft {
  enabled: boolean; mode: DiscoveryMode; maxDepth: string; maxDiscovered: string; maxDownloaded: string;
  storageGb: string; maxDurationMin: string; maxAgeDays: string; minScore: string; cooldownDays: string; intervalHours: string;
}

const toDraft = (b: DiscoveryBudget): BudgetDraft => ({
  enabled: b.enabled, mode: b.mode, maxDepth: String(b.maxDepth), maxDiscovered: String(b.maxDiscovered), maxDownloaded: String(b.maxDownloaded),
  storageGb: String(Math.round((b.maxStorageBytes / GB) * 100) / 100), maxDurationMin: String(Math.round(b.maxDurationSec / 60)),
  maxAgeDays: String(b.maxAgeDays), minScore: String(b.minScore), cooldownDays: String(b.cooldownDays), intervalHours: b.intervalHours ? String(b.intervalHours) : "",
});

function validateDraft(d: BudgetDraft): Record<string, string> {
  const e: Record<string, string> = {};
  const whole = (k: keyof BudgetDraft, min: number, max: number | undefined, msg: string) => {
    const n = Number(d[k]);
    if (d[k] === "" || !Number.isInteger(n) || n < min || (max !== undefined && n > max)) e[k] = msg;
  };
  whole("maxDepth", 0, 2, "Enter 0, 1 or 2.");
  whole("maxDiscovered", 0, undefined, "Enter a whole number, 0 or more.");
  whole("maxDownloaded", 0, undefined, "Enter a whole number, 0 or more.");
  whole("maxDurationMin", 1, undefined, "Enter a whole number of minutes, 1 or more.");
  whole("maxAgeDays", 1, undefined, "Enter a whole number of days, 1 or more.");
  whole("cooldownDays", 0, undefined, "Enter a whole number of days, 0 or more.");
  if (d.storageGb === "" || !(Number(d.storageGb) >= 0)) e.storageGb = "Enter a size in GB, 0 or more.";
  const sc = Number(d.minScore);
  if (d.minScore === "" || !(sc >= 0 && sc <= 1)) e.minScore = "Enter a number from 0 to 1.";
  if (d.intervalHours !== "" && !(Number(d.intervalHours) > 0)) e.intervalHours = "Enter hours above 0, or leave blank.";
  return e;
}

function fromDraft(d: BudgetDraft): DiscoveryBudget {
  const b: DiscoveryBudget = {
    enabled: d.enabled, mode: d.mode, maxDepth: Number(d.maxDepth), maxDiscovered: Number(d.maxDiscovered), maxDownloaded: Number(d.maxDownloaded),
    maxStorageBytes: Math.round(Number(d.storageGb) * GB), maxDurationSec: Number(d.maxDurationMin) * 60, maxAgeDays: Number(d.maxAgeDays),
    minScore: Number(d.minScore), cooldownDays: Number(d.cooldownDays),
  };
  if (d.intervalHours !== "") b.intervalHours = Number(d.intervalHours);
  return b;
}

const ADVANCED_KEYS = ["maxDepth", "maxDurationMin", "maxAgeDays", "minScore", "cooldownDays", "intervalHours"] as const;

function DiscoveryForm({ initial, onSaved }: { initial: Settings; onSaved: () => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<BudgetDraft>(() => toDraft({ ...DEFAULT_BUDGET, ...initial.discovery }));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const adv = useAdvancedDisclosure(ADVANCED_KEYS);
  const defaults = React.useMemo(() => toDraft(DEFAULT_BUDGET), []);
  const changed = ADVANCED_KEYS.filter((k) => draft[k] !== defaults[k]).length;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const errs = validateDraft(draft);
    setErrors(errs);
    setError(null);
    if (Object.keys(errs).length) { adv.reveal(errs); return; }
    setBusy(true);
    try {
      await saveSettingsPatch({ discovery: fromDraft(draft) });
      toast({ title: "Discovery settings saved", variant: "success" });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const num = (key: keyof BudgetDraft & string, label: string, hint: string, extra: { step?: string; min?: number } = {}) => (
    <Field id={`budget-${key}`} label={label} hint={hint} error={errors[key]}>
      {(p) => <Input {...p} type="number" inputMode="decimal" min={extra.min ?? 0} step={extra.step} value={draft[key] as string} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />}
    </Field>
  );

  return (
    <form ref={adv.formRef} onSubmit={save} noValidate className="space-y-6">
      <FormError message={error} />
      <ToggleRow id="budget-enabled" label="Discovery enabled" description="Turns discovery off everywhere when disabled.">{(p) => <Switch {...p} checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />}</ToggleRow>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="budget-mode" label="Default mode" hint="What happens to a recommendation once it is found.">
          {(p) => (
            <Select {...p} value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as DiscoveryMode })}>
              <option value="approval">Suggest for approval</option>
              <option value="auto">Download automatically</option>
              <option value="discovery_only">Catalogue only, no downloads</option>
            </Select>
          )}
        </Field>
        {num("maxDiscovered", "Maximum recommendations", "Recommendations kept in the catalogue.", { step: "1" })}
        {num("maxDownloaded", "Maximum downloads", "Recommended videos that may be downloaded at once.", { step: "1" })}
        {num("storageGb", "Storage limit (GB)", "Total space recommended downloads may use.", { step: "any" })}
      </div>
      <AdvancedSettings open={adv.open} onOpenChange={adv.setOpen} changed={changed}>
        <div className="grid gap-4 sm:grid-cols-2">
          {num("maxDepth", "Maximum depth", "0 to 2. How many steps away from your own videos to look.", { step: "1" })}
          {num("minScore", "Minimum score", "0 to 1. Recommendations scoring lower are dropped.", { step: "0.05" })}
          {num("maxDurationMin", "Longest video (minutes)", "Longer videos are skipped.", { step: "1", min: 1 })}
          {num("maxAgeDays", "Oldest video (days)", "Videos published longer ago are skipped.", { step: "1", min: 1 })}
          {num("cooldownDays", "Cooldown (days)", "Wait this long before recommending a rejected video again.", { step: "1" })}
          {num("intervalHours", "Run every (hours)", "Optional. Leave blank to run only when started manually or by the schedule.", { step: "any" })}
        </div>
      </AdvancedSettings>
      <SettingsFooter busy={busy} />
    </form>
  );
}

export default function DiscoverySettingsPage() {
  const result = useApi<Settings>("/api/settings");
  return (
    <SettingsPageShell title="Discovery" description="How much discovery can recommend and download, so it never fills the drive.">
      <Query result={result}>{(s) => <DiscoveryForm initial={s} onSaved={() => void result.mutate()} />}</Query>
    </SettingsPageShell>
  );
}

"use client";

import * as React from "react";
import { errorMessage, fieldErrors, useApi } from "@/lib/api";
import type { Settings } from "@/lib/types";
import { useToast } from "@/components/ui/toast";
import { Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field, FormError, ToggleRow } from "@/components/common/form";
import { Query } from "@/components/common/data";
import { AdvancedSettings, useAdvancedDisclosure } from "@/components/common/advanced-settings";
import { SettingsFooter, SettingsPageShell, saveSettingsPatch } from "@/components/settings/settings-page";

const ADVANCED_KEYS = ["xtreamAllowedCidrs"] as const;

function PlayersForm({ initial, onSaved }: { initial: Settings; onSaved: () => void }) {
  const { toast } = useToast();
  const [xtream, setXtream] = React.useState(initial.enableXtream);
  const [m3u, setM3u] = React.useState(initial.enableM3u);
  const [hls, setHls] = React.useState(initial.enableHls);
  const [cidrs, setCidrs] = React.useState(initial.xtreamAllowedCidrs.join("\n"));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const adv = useAdvancedDisclosure(ADVANCED_KEYS);
  const changed = (cidrs.trim() !== "" ? 1 : 0) + (hls ? 0 : 1);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({}); setError(null); setBusy(true);
    try {
      await saveSettingsPatch({ enableXtream: xtream, enableM3u: m3u, enableHls: hls, xtreamAllowedCidrs: cidrs.split(/[\s,]+/).filter(Boolean) });
      toast({ title: "External player settings saved", variant: "success" });
      onSaved();
    } catch (err) { const fe = fieldErrors(err); setErrors(fe); setError(errorMessage(err)); adv.reveal(fe); } finally { setBusy(false); }
  }

  return (
    <form ref={adv.formRef} onSubmit={submit} noValidate className="space-y-6">
      <FormError message={error} />
      <div className="space-y-4">
        <ToggleRow id="s-xt" label="Xtream Codes API" description="Lets apps such as UHF log in on port 3001.">{(p) => <Switch {...p} checked={xtream} onCheckedChange={setXtream} />}</ToggleRow>
        <ToggleRow id="s-m3u" label="M3U playlist" description="Lets players load your library as a playlist.">{(p) => <Switch {...p} checked={m3u} onCheckedChange={setM3u} />}</ToggleRow>
      </div>
      <AdvancedSettings open={adv.open} onOpenChange={adv.setOpen} changed={changed}>
        <Field id="s-cidr" label="Networks allowed for Xtream and M3U" hint="One CIDR range per line, for example 192.168.0.0/16. Leave empty to use the defaults. Use 0.0.0.0/0 only if you want to open access to the internet." error={errors.xtreamAllowedCidrs}>
          {(p) => <Textarea {...p} value={cidrs} onChange={(e) => setCidrs(e.target.value)} className="font-mono" rows={4} spellCheck={false} />}
        </Field>
        <ToggleRow id="s-hls" label="HLS streaming" description="Prepares segmented streams for files browsers can't play directly. Uses CPU and disk, so leave it off on a Raspberry Pi unless you need it.">{(p) => <Switch {...p} checked={hls} onCheckedChange={setHls} />}</ToggleRow>
      </AdvancedSettings>
      <SettingsFooter busy={busy} />
    </form>
  );
}

export default function PlayersSettingsPage() {
  const result = useApi<Settings>("/api/settings");
  return (
    <SettingsPageShell title="External player access" description="Whether apps such as UHF and VLC can connect, and from which networks. Player logins are managed on the External players page.">
      <Query result={result}>{(s) => <PlayersForm initial={s} onSaved={() => void result.mutate()} />}</Query>
    </SettingsPageShell>
  );
}

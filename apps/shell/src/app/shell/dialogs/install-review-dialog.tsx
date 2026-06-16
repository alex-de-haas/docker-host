"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { ChevronDown, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatRuntimeProfileLabel } from "../app-helpers";
import { SettingInput } from "../settings";
import type { CoreInstallPlan, InstallPanelState } from "../types";
import { CheckboxRow, EmptyState, FactCard, InlineError } from "../ui";

export function InstallReviewDialog({
  opened,
  detail,
  busyAction,
  onClose,
  onReview,
  onApply,
}: {
  opened: boolean;
  detail: InstallPanelState;
  busyAction: string | null;
  onClose: () => void;
  onReview: (manifestPath: string, selectedRuntime?: string | null) => void;
  onApply: (plan: CoreInstallPlan, settings: Record<string, string | null>, autostart: boolean) => void;
}) {
  const [manifestPath, setManifestPath] = useState("");
  const [selectedRuntime, setSelectedRuntime] = useState("");
  const [reviewedManifestPath, setReviewedManifestPath] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string>>({});
  const [autostartDraft, setAutostartDraft] = useState(true);

  // Reset the settings draft while rendering when the reviewed plan changes, instead
  // of in an effect. https://react.dev/learn/you-might-not-need-an-effect
  const reviewedPlan = detail.plan && manifestPath.trim() === reviewedManifestPath ? detail.plan : null;
  const [prevReviewedPlan, setPrevReviewedPlan] = useState<CoreInstallPlan | null>(null);
  if (prevReviewedPlan !== reviewedPlan) {
    setPrevReviewedPlan(reviewedPlan);
    if (!reviewedPlan) {
      setSettingsDraft({});
    } else {
      setSelectedRuntime(reviewedPlan.targetRuntime);
      setSettingsDraft(Object.fromEntries(reviewedPlan.settings.map((setting) => [setting.key, setting.secret ? "" : setting.defaultValue || ""])));
      setAutostartDraft(reviewedPlan.defaultAutostart ?? true);
    }
  }
  const runtimeProfiles =
    reviewedPlan?.runtimeProfiles && reviewedPlan.runtimeProfiles.length > 0
      ? reviewedPlan.runtimeProfiles
      : reviewedPlan
        ? [{ key: reviewedPlan.targetRuntime, type: reviewedPlan.targetRuntimeType, default: true }]
        : [];
  const selectedRuntimeValue = selectedRuntime || reviewedPlan?.targetRuntime || "";
  const selectedRuntimeProfile = runtimeProfiles.find((profile) => profile.key === selectedRuntimeValue);
  const selectedRuntimeLabel = selectedRuntimeProfile ? formatRuntimeProfileLabel(selectedRuntimeProfile) : selectedRuntimeValue || "Select runtime";

  const submitReview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedManifestPath = manifestPath.trim();
    setReviewedManifestPath(normalizedManifestPath);
    setSelectedRuntime("");
    onReview(normalizedManifestPath);
  };

  const changeRuntime = (runtime: string) => {
    setSelectedRuntime(runtime);
    onReview(manifestPath.trim(), runtime);
  };

  const apply = () => {
    if (!reviewedPlan) {
      return;
    }

    const settings: Record<string, string | null> = {};
    for (const setting of reviewedPlan.settings) {
      const value = settingsDraft[setting.key] ?? "";
      if (!setting.secret || value.length > 0) {
        settings[setting.key] = value;
      }
    }

    onApply(reviewedPlan, settings, autostartDraft);
  };

  return (
    <Dialog open={opened} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Install App</DialogTitle>
          <DialogDescription>Review a runtime app manifest before installing it into Core.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submitReview} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="manifestPath">Manifest, app directory, or URL</Label>
            <Input
              id="manifestPath"
              value={manifestPath}
              onChange={(event) => setManifestPath(event.target.value)}
              placeholder="/path/to/app, /path/to/manifest.json, or https://example.test/manifest.json"
              required
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="outline" disabled={detail.loading || manifestPath.trim().length === 0}>
              {detail.loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Review
            </Button>
          </div>
        </form>

        {detail.error && <InlineError message={detail.error} />}
        {detail.loading && !reviewedPlan && <EmptyState icon={LoaderCircle} title="Loading install review" iconClassName="animate-spin" />}

        {reviewedPlan && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{reviewedPlan.displayName}</h3>
                <p className="text-sm text-muted-foreground">{reviewedPlan.description || "Runtime app manifest reviewed."}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="selectedRuntime">Runtime</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      id="selectedRuntime"
                      type="button"
                      variant="outline"
                      className="w-full justify-between px-3 font-normal"
                      disabled={detail.loading || runtimeProfiles.length <= 1}
                    >
                      <span className="truncate">{selectedRuntimeLabel}</span>
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[var(--radix-dropdown-menu-trigger-width)]">
                    <DropdownMenuRadioGroup value={selectedRuntimeValue} onValueChange={changeRuntime}>
                      {runtimeProfiles.map((profile) => (
                        <DropdownMenuRadioItem key={profile.key} value={profile.key}>
                          {formatRuntimeProfileLabel(profile)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FactCard label="App" value={reviewedPlan.displayName} />
              <FactCard label="Version" value={reviewedPlan.currentVersion ? `${reviewedPlan.currentVersion} to ${reviewedPlan.targetVersion}` : reviewedPlan.targetVersion} />
              <FactCard label="Runtime" value={reviewedPlan.targetRuntime} />
              <FactCard label="Manifest digest" value={reviewedPlan.targetManifestDigest.slice(0, 16)} />
            </div>
            {reviewedPlan.settings.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Settings</h3>
                {reviewedPlan.settings.map((setting) => (
                  <SettingInput key={setting.key} setting={setting} value={settingsDraft[setting.key] ?? ""} onChange={(value) => setSettingsDraft((current) => ({ ...current, [setting.key]: value }))} />
                ))}
              </div>
            )}
            <div className="rounded-md border bg-muted/30 p-3">
              <CheckboxRow label="Start at Core startup" checked={autostartDraft} onChange={setAutostartDraft} />
            </div>
            <DialogFooter>
              {reviewedPlan.action !== "install" && <p className="text-sm text-muted-foreground">Already installed</p>}
              <Button onClick={apply} disabled={reviewedPlan.action !== "install" || detail.loading || busyAction === "install"}>
                {busyAction === "install" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Install App
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

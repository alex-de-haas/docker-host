"use client";
import { useRef, useState } from "react";
import { Check, ImagePlus, Monitor, Moon, Palette, Sun, UserRound } from "lucide-react";
import { saveWallpaper } from "@/lib/wallpaper";
import type { Theme, User, Workspace } from "@/lib/model";

export function Appearance({ user, workspace, resolved, custom, onChange, onUpload }: {
  user: User; workspace: Workspace; resolved: "light" | "dark"; custom: string | null;
  onChange: (patch: Partial<Workspace>) => void; onUpload: (file: File) => void;
}) {
  const [tab, setTab] = useState("appearance"), [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const choices = [
    { id: "coast" as const, label: "Coastal light", description: "Follows your appearance", src: `/wallpapers/coast-${resolved}.png` },
    { id: "night" as const, label: "Blue hour", description: "A quieter view", src: "/wallpapers/coast-dark.png" },
    ...(custom ? [{ id: "custom" as const, label: "Your wallpaper", description: "Personal image", src: custom }] : []),
  ];
  return <div className="appearance-layout">
    <nav className="window-sidebar" aria-label="Personal settings">
      <button className={tab === "appearance" ? "selected" : ""} onClick={() => setTab("appearance")}><Palette size={18} />Appearance</button>
      <button className={tab === "profile" ? "selected" : ""} onClick={() => setTab("profile")}><UserRound size={18} />Profile</button>
    </nav>
    <div className="settings-document">
      {tab === "profile" ? <><span className="section-eyebrow">YOUR ACCOUNT</span><h1>{user.displayName || "Your profile"}</h1><p className="muted">{user.email}</p>
        <div className="profile-row"><span>Host access</span><strong>{user.role === "host.admin" ? "Administrator" : "User"}</strong></div>
        <p className="settings-note">Your desktop layout and appearance are saved for this account in this browser.</p></>
      : <><span className="section-eyebrow">MAKE YOURSELF AT HOME</span><h1>Appearance</h1><p className="settings-intro">A little more you. A little less distraction.</p>
        <h2>Theme</h2><div className="theme-options" role="group" aria-label="Theme">
          {([{ value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon }, { value: "system", label: "System", icon: Monitor }] as const).map(({ value, label, icon: Icon }) =>
            <button key={value} aria-pressed={workspace.theme === value} className={workspace.theme === value ? "selected" : ""} onClick={() => onChange({ theme: value as Theme })}><Icon size={19} /><span>{label}</span>{workspace.theme === value && <Check size={14} />}</button>)}
        </div>
        <h2>Wallpaper</h2><div className="wallpaper-options">
          {choices.map(choice => <button key={choice.id} className={`wallpaper-choice ${workspace.wallpaper === choice.id ? "selected" : ""}`} aria-pressed={workspace.wallpaper === choice.id} onClick={() => onChange({ wallpaper: choice.id })}>
            <span className="wallpaper-thumbnail" style={{ backgroundImage: `url("${choice.src}")` }}>{workspace.wallpaper === choice.id && <span className="wallpaper-check"><Check size={14} /></span>}</span>
            <strong>{choice.label}</strong><small>{choice.description}</small>
          </button>)}
        </div>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label="Choose wallpaper image" onChange={async event => {
          const file = event.target.files?.[0]; if (!file) return;
          try { await saveWallpaper(user.id, file); onUpload(file); onChange({ wallpaper: "custom" }); setError(null); }
          catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save wallpaper."); }
          event.target.value = "";
        }} />
        <button className="subtle-button upload-wallpaper" onClick={() => input.current?.click()}><ImagePlus size={17} />Choose your own image</button>
        <p className="settings-note">JPEG, PNG or WebP, up to 12 MB. Saved only in this browser.</p>
        {error && <p className="inline-error" role="alert">{error}</p>}
      </>}
    </div>
  </div>;
}

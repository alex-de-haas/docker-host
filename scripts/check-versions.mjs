#!/usr/bin/env node
// Version-consistency guard (review §2.4). Several version strings are hand-maintained in more than one
// place and have drifted repeatedly (demo-app baked version stale by two minors; channels cliVersion
// stale vs the platform; a Shell footer once showed the wrong version). This asserts the copies agree
// so drift fails CI instead of shipping. Pure Node, no dependencies. Exits non-zero listing every
// mismatch.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(repoRoot, relative), "utf8");
const json = (relative) => JSON.parse(read(relative));

const problems = [];
// Records a check: `label` names the invariant, `values` maps each source → its version string. Every
// source is expected to resolve; a null (a regex/format change that failed to capture) is reported
// loudly rather than silently skipped, so parsing failures can't let the check pass without verifying.
function expectEqual(label, values) {
  const entries = Object.entries(values);
  const missing = entries.filter(([, value]) => value == null);
  if (missing.length > 0) {
    problems.push(`${label} missing sources: ${missing.map(([source]) => source).join(", ")}`);
  }

  const present = entries.filter(([, value]) => value != null);
  const distinct = new Set(present.map(([, value]) => value));
  if (distinct.size > 1) {
    problems.push(
      `${label}: ${present.map(([source, value]) => `${source}=${value}`).join(", ")}`,
    );
  }
}

// Extracts a value via the first capture group of `pattern`, or null when absent.
function capture(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : null;
}

const platformVersion = capture(read("Directory.Build.props"), /<Version>([^<]+)<\/Version>/);

// demo-app: manifest ↔ package ↔ the two baked copies (Dockerfile ENV + the config default). The
// feeds.json points its `main` feed at the manifest on the main branch. The version remains
// informational and ships with the manifest, so there is no per-release feed advertisement to drift.
const demoManifest = json("apps/demo-app/manifest.json");
const demoFeeds = json("apps/demo-app/feeds.json");
expectEqual("demo-app version", {
  manifest: demoManifest.version,
  packageJson: json("apps/demo-app/package.json").version,
  dockerfile: capture(read("apps/demo-app/Dockerfile"), /HOSTY_APP_VERSION=([^\s]+)/),
  demoConfig: capture(read("apps/demo-app/src/lib/demo-config.ts"), /defaultAppVersion\s*=\s*"([^"]+)"/),
});
expectEqual("demo-app feed identity", {
  manifest: demoManifest.id,
  feeds: demoFeeds.appId,
});
if (demoFeeds.schemaVersion !== "app-feeds.0.1") {
  problems.push(`demo-app feeds schema: expected app-feeds.0.1, got ${demoFeeds.schemaVersion ?? "(missing)"}`);
}

// shell: manifest ↔ package.
expectEqual("shell version", {
  manifest: json("apps/shell/manifest.json").version,
  packageJson: json("apps/shell/package.json").version,
});

// telemetry: the manifest version ↔ the backend image tag it pins (see R-M1).
const telemetryManifest = json("apps/telemetry/manifest.json");
const backendImageTag = telemetryManifest.services
  ?.find((service) => service.key === "backend")
  ?.runtimes?.docker?.image?.tag;
expectEqual("telemetry backend image tag", {
  manifest: telemetryManifest.version,
  backendImageTag,
});

// marketplace: manifest ↔ package ↔ the api image tag it pins (shell + telemetry couplings combined).
const marketplaceManifest = json("apps/marketplace/manifest.json");
const marketplaceImageTag = marketplaceManifest.services
  ?.find((service) => service.key === "api")
  ?.runtimes?.docker?.image?.tag;
expectEqual("marketplace version", {
  manifest: marketplaceManifest.version,
  packageJson: json("apps/marketplace/package.json").version,
  marketplaceImageTag,
});

// channels: the rolling channel (releaseTag cli-dev tracks main HEAD) must advertise the platform version.
const channels = json("channels/product-channels.json").channels ?? [];
for (const channel of channels) {
  if (channel.releaseTag === "cli-dev" && channel.cliVersion != null) {
    expectEqual(`channel '${channel.id}' cliVersion`, {
      channel: channel.cliVersion,
      platform: platformVersion,
    });
  }
}

if (problems.length > 0) {
  console.error("Version drift detected:");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error("\nUpdate the mismatched sources so every copy agrees.");
  process.exit(1);
}

console.log("Version consistency OK.");

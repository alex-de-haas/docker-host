import type { AppProblem, CoreApp, CoreAppDependency } from "./types";

// Kept a leaf module — types only, no runtime imports — so it stays directly testable under
// `node --test`, which cannot resolve the extensionless specifiers app-helpers reaches for.

// Whether the app has a required setting we can see is unset. Non-secret only: the API never surfaces
// secret values, so a required secret can't be judged here — Core is the authoritative gate that refuses
// the start (app_required_settings_missing).
export function appHasMissingRequiredSettings(app: CoreApp) {
  return (app.settings ?? []).some(
    (setting) => setting.required && !setting.secret && (setting.value ?? "").trim().length === 0,
  );
}

// Every problem derivable from the app record alone. The collapsed row's icons and the panel's alert list
// both render from this one call, so what the row warns about and what the panel explains can never drift
// apart — before this they were computed independently in two places.
//
// Deliberately excludes anything that needs a probe: health failures, digest drift, and an unreachable
// registry are unknown until a row is expanded, so they cannot honestly drive a collapsed-row icon. Those
// stay next to the data they describe, rendered with the same Alert for a consistent look.
export function collectAppProblems(app: CoreApp): AppProblem[] {
  const problems: AppProblem[] = [];

  if (app.lastError) {
    problems.push({ severity: "error", title: "Last operation failed", detail: app.lastError });
  }

  const unavailable = (app.endpoints ?? []).filter((endpoint) => endpoint.availability === "unavailable");
  if (unavailable.length > 0) {
    const names = unavailable.map((endpoint) => (endpoint.service ? `${endpoint.service}.${endpoint.key}` : endpoint.key));
    problems.push({
      severity: "error",
      title: unavailable.length === 1 ? "A reserved host port failed to bind" : `${unavailable.length} reserved host ports failed to bind`,
      detail: `${names.join(", ")} — something else on this host is holding the port. Reassign it from the endpoint below, or free the port and restart the app.`,
    });
  }

  // Only worth raising while the app is genuinely idle: a running app already got past this gate, and
  // an app mid-start is being validated by Core right now — flagging it there would blink a warning on
  // and off for every start. Deliberately `isIdle`, not `!== "running"`, which is what it used to be.
  //
  // Inlined rather than imported from ./runtime-states because this module is kept free of runtime
  // imports so it stays directly testable under `node --test`, which cannot resolve extensionless
  // relative specifiers. Keep the two in step.
  if (app.runtimeState === "stopped" && appHasMissingRequiredSettings(app)) {
    problems.push({
      severity: "warning",
      title: "Required settings have no value",
      detail: "This app cannot start until every required setting is filled in.",
    });
  }

  if (app.manifestError) {
    problems.push({
      severity: "warning",
      title: "The live manifest was rejected at last start",
      detail: `Core kept the previous manifest running: ${app.manifestError}`,
    });
  }

  problems.push(...collectDependencyProblems(app.dependencies));

  // A failed update check is deliberately absent: it already has its own marker beside the row's update
  // affordance, gated on the app actually supporting reviewed updates. Repeating it here would report the
  // same problem twice, and would report it for live-source apps that have no update path at all.

  return problems;
}

// Cross-app dependency state, rendered beside the app instead of published as a notification: a
// dependency being down is a condition that resolves itself the moment the operator starts it, and a
// notification store with no revoke could only ever accumulate stale ones. Core sends state; the
// severity split lives here.
//
// A dependency the operator never installed is only a problem when it is REQUIRED. An optional one
// they chose not to install is a choice, and an icon for it would teach operators to ignore the icon.
function collectDependencyProblems(dependencies: CoreApp["dependencies"]): AppProblem[] {
  const problems: AppProblem[] = [];

  for (const dependency of dependencies ?? []) {
    const name = describeDependency(dependency);

    if (!dependency.installed) {
      if (dependency.required) {
        problems.push({
          severity: "error",
          title: `Required dependency ${dependency.appId} is not installed`,
          detail: `This app wires ${name}, which is not installed. Hosty never auto-installs a dependency — install it so the wired endpoints resolve.`,
        });
      }
      continue;
    }

    if (!dependency.running) {
      problems.push({
        severity: dependency.required ? "error" : "warning",
        title: `${dependency.required ? "Required" : "Optional"} dependency ${dependency.appId} is not running`,
        detail: `This app wires ${name}, which is installed but stopped. Start it so the wired endpoints resolve.`,
      });
      continue;
    }

    // Running, so the only thing left to check is whether each wired endpoint actually resolves: an
    // unresolved one silently drops its HOSTY_DEPENDENCY_{ALIAS}_URL, which is invisible from inside
    // the consumer. Always a warning — the dependency itself is healthy, the wiring is not.
    const unresolved = (dependency.endpoints ?? []).filter((endpoint) => !endpoint.resolved);
    if (unresolved.length > 0) {
      const keys = unresolved.map((endpoint) => endpoint.endpointKey).join(", ");
      const vars = unresolved.map((endpoint) => `HOSTY_DEPENDENCY_${endpoint.alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`).join(", ");
      problems.push({
        severity: "warning",
        title: unresolved.length === 1
          ? `Dependency endpoint ${dependency.appId}/${keys} is unavailable`
          : `${unresolved.length} dependency endpoints of ${dependency.appId} are unavailable`,
        detail: `${keys} has no resolvable URL, so ${vars} is missing from this app's environment. Check the endpoint key against the dependency's manifest.`,
      });
    }
  }

  return problems;
}

function describeDependency(dependency: CoreAppDependency) {
  return dependency.version ? `${dependency.appId} (${dependency.version})` : dependency.appId;
}

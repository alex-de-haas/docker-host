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

export function appReadinessProblem(app: CoreApp): AppProblem | null {
  if (app.operationStatus === "updating" || app.runtimeState === "starting" || app.runtimeState === "stopping") return null;
  const afterUpdate = app.lastOperation === "update" && app.updateProgress?.stage === "needs-attention";
  if (app.health?.status === "healthy") return null;
  if (!afterUpdate && (app.runtimeState !== "running" || !["degraded", "unhealthy"].includes(app.health?.status ?? ""))) return null;
  const services = (app.health?.services ?? []).filter(service => service.status !== "running" ||
    (service.health != null && service.health !== "healthy"));
  const details = services.map(service => `${service.service}: ${service.health ?? service.status}`).join("; ");
  return {
    severity: "warning",
    title: afterUpdate ? "Update installed, but app is not ready" : "App is running, but not ready",
    detail: `${afterUpdate ? "Installation finished, but readiness checks did not pass." : "One or more services have not passed readiness checks."}${details ? ` ${details}.` : ""} Open console logs to investigate.${app.updateCheck?.updateAvailable && !app.updateCheck.error ? " The available update is separate from this readiness warning." : ""}`,
  };
}

// Every problem derivable from the app record alone. The collapsed row's icons and the panel's alert list
// both render from this one call, so what the row warns about and what the panel explains can never drift
// apart — before this they were computed independently in two places.
//
// Probe-only health and digest details stay beside the services. Persisted update-check failures are
// already known from the app summary and must explain the Dashboard's attention count.
export function collectAppProblems(app: CoreApp): AppProblem[] {
  const problems: AppProblem[] = [];

  const permissions = app.permissionState;
  if (permissions?.status === "known" && permissions.unsupportedRequired?.length) {
    problems.push({ severity: "error", action: "permissions", title: "Required permissions are unsupported",
      detail: `Core does not support these required permissions: ${permissions.unsupportedRequired.join(", ")}. Install compatible app/Core versions or wait for an app update.` });
  }
  if (permissions?.status === "known" && permissions.missingRequired.length > 0) {
    problems.push({ severity: "error", action: "permissions", title: "Required permissions need approval",
      detail: `Operations requiring these permissions are unavailable until approval: ${permissions.missingRequired.join(", ")}. Review them in Settings → Permissions.` });
  } else if (permissions?.error) {
    problems.push({ severity: "warning", action: "permissions", title: "Permission manifest could not be checked", detail: permissions.error });
  }

  if (app.lastError) {
    problems.push({ severity: "error", title: "Last operation failed", detail: app.lastError });
  }
  const readiness = appReadinessProblem(app);
  if (readiness) problems.push(readiness);

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

  if (app.updateCheck?.error) {
    problems.push({
      severity: "warning",
      title: "Update check failed",
      detail: app.updateCheck.error,
    });
  }

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

    // Running, but the service behind a wired endpoint is not answering — still inside its readiness
    // budget, or it stopped answering. A warning, never an error: the provider is up, and its
    // supervisor keeps observing it. Only a Core that reports readiness can say this (`healthy` is
    // absent otherwise), so the check is on the field being false, not on it being missing.
    if (dependency.healthy === false) {
      problems.push({
        severity: "warning",
        title: `${dependency.required ? "Required" : "Optional"} dependency ${dependency.appId} is not answering yet`,
        detail: `This app wires ${name}, which is running but whose service is not confirmed to answer. It usually settles on its own; check the dependency's health if it does not.`,
      });
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

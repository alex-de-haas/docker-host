#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.HOSTY_DEV_DATA_ROOT || path.join(repoRoot, ".hosty-dev"));
const coreUrl = process.env.HOSTY_CORE_URL || "http://localhost:3001";
const shellOrigin = process.env.HOST_SHELL_PUBLIC_ORIGIN || "http://localhost:3000";
const coreEndpoint = parseEndpoint(coreUrl);
const shellEndpoint = parseEndpoint(shellOrigin);
const developmentUsers = [
  {
    id: process.env.HOSTY_DEV_USER_ID || "user_dev_admin",
    email: process.env.HOSTY_DEV_USER_EMAIL || "admin@hosty.local",
    displayName: process.env.HOSTY_DEV_USER_NAME || "Local Admin",
    role: "host.admin",
  },
  {
    id: process.env.HOSTY_DEV_LOCAL_USER_ID || "user_dev_local",
    email: process.env.HOSTY_DEV_LOCAL_USER_EMAIL || "user@hosty.local",
    displayName: process.env.HOSTY_DEV_LOCAL_USER_NAME || "Local User",
    role: "host.user",
  },
];
const devAdmin = developmentUsers[0];

try {
  await seedDevelopmentUsers();
  await assertPortAvailable("Core", coreEndpoint);
  await assertPortAvailable("Shell", shellEndpoint);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Example with alternate ports:");
  console.error("  HOSTY_CORE_URL=http://localhost:3301 HOST_SHELL_PUBLIC_ORIGIN=http://localhost:3300 npm run dev");
  process.exit(1);
}

const commonEnv = {
  ...process.env,
  HOSTY_CORE_URL: coreUrl,
  HOSTY_CORE_DATA_ROOT: dataRoot,
  HOST_CORE_PUBLIC_ORIGIN: coreUrl,
  HOST_SHELL_PUBLIC_ORIGIN: shellOrigin,
};

const children = [];
let shuttingDown = false;

start("Core", "dotnet", ["run", "--no-launch-profile", "--project", "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj"], {
  ...commonEnv,
  DOTNET_ENVIRONMENT: "Development",
  HOSTY_SHELL_BOOTSTRAP_ENABLED: "true",
  HOSTY_SHELL_BOOTSTRAP_RUNTIME: "dev",
  HOSTY_SHELL_SOURCE_OVERRIDE_PATH: repoRoot,
  HOSTY_SHELL_AUTOSTART: "true",
});

console.log("");
console.log("Hosty local development is starting.");
console.log(`Core:  ${coreUrl}`);
console.log(`Shell: ${shellOrigin}`);
console.log(`Data:  ${dataRoot}`);
console.log(`Dev users: ${developmentUsers.map((user) => `${user.email} (${user.role})`).join(", ")}`);
console.log("");
console.log(`Open ${shellOrigin}. If redirected to Core login, select ${devAdmin.email}.`);
console.log("Press Ctrl+C to stop Core and Shell.");

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
process.on("exit", () => {
  if (!shuttingDown) {
    stopAll("SIGTERM");
  }
});

function start(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    console.error(`${label} exited${signal ? ` with signal ${signal}` : ` with code ${code}`}.`);
    stopAll("SIGTERM");
    process.exitCode = code ?? 1;
  });
}

function stopAll(signal) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed && child.exitCode === null) {
      child.kill(signal);
    }
  }
}

async function seedDevelopmentUsers() {
  const authDirectory = path.join(dataRoot, "core", "auth");
  const statePath = path.join(authDirectory, "state.json");
  await mkdir(authDirectory, { recursive: true });

  const state = existsSync(statePath)
    ? JSON.parse(await readFile(statePath, "utf8"))
    : { schemaVersion: 1, users: [], invitations: [], assignments: [], sessions: [] };

  state.schemaVersion ??= 1;
  state.users ??= [];
  state.invitations ??= [];
  state.assignments ??= [];
  state.sessions ??= [];

  const now = new Date().toISOString();
  let changed = false;

  for (const user of developmentUsers) {
    const existingIndex = state.users.findIndex((candidate) => isSameDevelopmentUser(candidate, user));
    if (existingIndex === -1) {
      state.users.push({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        disabled: false,
        createdAt: now,
        updatedAt: now,
      });
      changed = true;
      continue;
    }

    const existing = state.users[existingIndex];
    if (
      !existing.id ||
      existing.email !== user.email ||
      existing.displayName !== user.displayName ||
      existing.role !== user.role ||
      existing.disabled !== false
    ) {
      state.users[existingIndex] = {
        ...existing,
        id: existing.id || user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        disabled: false,
        updatedAt: now,
      };
      changed = true;
    }
  }

  if (changed) {
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function isSameDevelopmentUser(candidate, developmentUser) {
  if (!candidate) {
    return false;
  }

  return candidate.id === developmentUser.id ||
    (typeof candidate.email === "string" && candidate.email.toLowerCase() === developmentUser.email.toLowerCase());
}

function parseEndpoint(origin) {
  const url = new URL(origin);
  return {
    hostname: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
}

async function assertPortAvailable(label, endpoint) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`${label} port ${endpoint.hostname}:${endpoint.port} is not available (${error.code || error.message}). Stop the existing process or set a different origin.`));
    });
    server.once("listening", () => {
      server.close(resolve);
    });
    server.listen(endpoint.port, endpoint.hostname);
  });
}

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
const devUser = {
  id: process.env.HOSTY_DEV_USER_ID || "user_dev_admin",
  email: process.env.HOSTY_DEV_USER_EMAIL || "admin@hosty.local",
  displayName: process.env.HOSTY_DEV_USER_NAME || "Local Admin",
};

try {
  await seedDevelopmentAdmin();
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
  HOSTY_SHELL_BOOTSTRAP_ENABLED: "false",
  HOSTY_SHELL_AUTOSTART: "false",
});
start("Shell", "npm", ["run", "shell:dev"], {
  ...commonEnv,
  HOSTY_CORE_ORIGIN: coreUrl,
  HOSTNAME: shellEndpoint.hostname,
  NEXT_PUBLIC_HOSTY_CORE_ORIGIN: coreUrl,
  PORT: String(shellEndpoint.port),
});

console.log("");
console.log("Hosty local development is starting.");
console.log(`Core:  ${coreUrl}`);
console.log(`Shell: ${shellOrigin}`);
console.log(`Data:  ${dataRoot}`);
console.log(`Dev admin: ${devUser.email}`);
console.log("");
console.log(`Open ${shellOrigin}. If redirected to Core login, select ${devUser.email}.`);
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

async function seedDevelopmentAdmin() {
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

  const hasEnabledUser = state.users.some((user) => user && user.disabled !== true);
  if (!hasEnabledUser) {
    const now = new Date().toISOString();
    state.users.push({
      id: devUser.id,
      email: devUser.email,
      displayName: devUser.displayName,
      role: "host.admin",
      disabled: false,
      createdAt: now,
      updatedAt: now,
    });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
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

import Docker from 'dockerode';

const DEFAULT_DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const DEFAULT_SELF_UPDATE_GRACE_PERIOD_MS = 5_000;

const docker = new Docker(resolveDockerConnection());

const originalId = requireEnv('ORIGINAL_CONTAINER_ID');
const originalName = requireEnv('ORIGINAL_CONTAINER_NAME');
const replacementId = requireEnv('REPLACEMENT_CONTAINER_ID');
const replacementName = requireEnv('REPLACEMENT_CONTAINER_NAME');
const startReplacement = process.env.START_REPLACEMENT === 'true';
const gracePeriodMs = parseNumberEnv('SELF_UPDATE_GRACE_PERIOD_MS', DEFAULT_SELF_UPDATE_GRACE_PERIOD_MS);

await sleep(gracePeriodMs);
await replaceContainer();

async function replaceContainer() {
  const original = docker.getContainer(originalId);
  const replacement = docker.getContainer(replacementId);
  const backupName = `${originalName}-backup-${Date.now()}`;

  let stoppedOriginal = false;
  let renamedOriginal = false;
  let renamedReplacement = false;
  let replacementStarted = false;

  try {
    if (startReplacement) {
      await original.stop();
      stoppedOriginal = true;
    }

    await original.rename({ name: backupName });
    renamedOriginal = true;

    await replacement.rename({ name: originalName });
    renamedReplacement = true;

    if (startReplacement) {
      await replacement.start();
      replacementStarted = true;
    }

    await original.remove({ force: true }).catch(() => undefined);
  } catch (error) {
    if (replacementStarted) {
      await replacement.stop().catch(() => undefined);
    }

    if (renamedReplacement) {
      await replacement.rename({ name: replacementName }).catch(() => undefined);
    }

    if (renamedOriginal) {
      await original.rename({ name: originalName }).catch(() => undefined);
    }

    if (stoppedOriginal) {
      await original.start().catch(() => undefined);
    }

    console.error('Self-update helper failed:', error);
    process.exitCode = 1;
  }
}

function resolveDockerConnection() {
  const socketPath = process.env.DOCKER_SOCKET_PATH?.trim();
  if (socketPath) {
    return { socketPath };
  }

  const dockerHost = process.env.DOCKER_HOST?.trim();
  if (dockerHost) {
    return parseDockerHost(dockerHost);
  }

  return { socketPath: DEFAULT_DOCKER_SOCKET_PATH };
}

function parseDockerHost(dockerHost) {
  if (dockerHost.startsWith('unix://')) {
    return { socketPath: dockerHost.slice('unix://'.length) };
  }

  const url = new URL(dockerHost);
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port ? Number(url.port) : protocol === 'https' ? 2376 : 2375;

  return {
    host: url.hostname,
    port,
    protocol,
  };
}

function requireEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseNumberEnv(name, fallback) {
  const rawValue = process.env[name];
  const parsedValue = rawValue ? Number.parseInt(rawValue, 10) : NaN;
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getHostRuntimeConfig } from './host-runtime.ts';

export const CONTROL_CONTRACT_VERSION = '0.1';
export const CONTROL_SECRET_HEADER = 'x-docker-host-control-secret';
export const CONTROL_CONTRACT_HEADER = 'x-docker-host-control-contract-version';
export const LOCAL_CONTROL_ACTOR_ID = 'local-cli';

interface ControlDiscoveryFile {
  controlContractVersion?: string;
  secret?: string;
}

export async function requireTrustedControl(request: Request): Promise<NextResponse | null> {
  const requestedVersion = request.headers.get(CONTROL_CONTRACT_HEADER);
  if (requestedVersion !== CONTROL_CONTRACT_VERSION) {
    return NextResponse.json({
      error: {
        code: 'unsupported_control_contract',
        message: `Unsupported Docker Host control contract "${requestedVersion || 'missing'}".`,
        supportedVersion: CONTROL_CONTRACT_VERSION,
      },
    }, { status: 426 });
  }

  const expectedSecret = await readControlSecret();
  const providedSecret = request.headers.get(CONTROL_SECRET_HEADER);
  if (!expectedSecret || !providedSecret || !constantTimeEquals(expectedSecret, providedSecret)) {
    return NextResponse.json({
      error: {
        code: 'control_unauthorized',
        message: 'The trusted local control secret is missing or invalid.',
      },
    }, { status: 401 });
  }

  return null;
}

async function readControlSecret() {
  const config = getHostRuntimeConfig();
  const discoveryPath = path.join(config.dataRootContainer, 'run', 'control.json');
  let parsed: ControlDiscoveryFile | null;
  try {
    parsed = JSON.parse(await fs.readFile(discoveryPath, 'utf-8')) as ControlDiscoveryFile;
  } catch {
    return null;
  }

  return parsed?.controlContractVersion === CONTROL_CONTRACT_VERSION &&
    typeof parsed?.secret === 'string' &&
    parsed.secret.length > 0
    ? parsed.secret
    : null;
}

function constantTimeEquals(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

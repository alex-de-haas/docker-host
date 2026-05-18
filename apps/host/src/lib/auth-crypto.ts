import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  type ScryptOptions,
  timingSafeEqual,
} from 'node:crypto';

const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SALT_LENGTH = 16;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export interface PasswordPolicyResult {
  valid: boolean;
  errors: string[];
}

export function validatePasswordPolicy(password: string): PasswordPolicyResult {
  const errors: string[] = [];
  const normalized = password.trim();
  const weakValues = new Set([
    'passwordpassword',
    'dockerhost123',
    'docker-host-123',
    'administrator',
    'adminadminadmin',
  ]);

  if (password.length < 12) {
    errors.push('Password must contain at least 12 characters.');
  }

  if (normalized.length !== password.length) {
    errors.push('Password must not start or end with whitespace.');
  }

  if (weakValues.has(password.toLowerCase())) {
    errors.push('Password is too easy to guess.');
  }

  if (/^(.)\1+$/.test(password)) {
    errors.push('Password must not repeat the same character.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export async function hashPassword(password: string) {
  const salt = randomBytes(PASSWORD_SALT_LENGTH);
  const hash = await derivePasswordKey(password, salt);

  return [
    'scrypt',
    `n=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P},keylen=${PASSWORD_KEY_LENGTH}`,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encodedHash: string) {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) {
    return false;
  }

  const hash = await scryptAsync(password, parsed.salt, parsed.keyLength, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer;

  return safeEqual(hash, parsed.hash);
}

export function generateToken(prefix: string) {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function safeEqualString(left: string, right: string) {
  return safeEqual(Buffer.from(left), Buffer.from(right));
}

async function derivePasswordKey(password: string, salt: Buffer) {
  return await scryptAsync(password, salt, PASSWORD_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });
}

function parsePasswordHash(encodedHash: string) {
  const [algorithm, paramsValue, saltValue, hashValue] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !paramsValue || !saltValue || !hashValue) {
    return null;
  }

  const params = Object.fromEntries(
    paramsValue.split(',').map(part => {
      const [key, value] = part.split('=');
      return [key, Number(value)];
    })
  );

  if (!params.n || !params.r || !params.p || !params.keylen) {
    return null;
  }

  return {
    n: params.n,
    r: params.r,
    p: params.p,
    keyLength: params.keylen,
    salt: Buffer.from(saltValue, 'base64url'),
    hash: Buffer.from(hashValue, 'base64url'),
  };
}

function safeEqual(left: Buffer, right: Buffer) {
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

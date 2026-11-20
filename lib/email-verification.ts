import crypto from 'node:crypto';
import sql from '@/lib/db';
import { initDb } from '@/lib/auth-utils';

export const VERIFICATION_CODE_LENGTH = 6;
export const VERIFICATION_EXPIRY_MINUTES = 15;
export const VERIFICATION_MAX_ATTEMPTS = 5;
export const VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;

export interface PendingVerification {
  id: number;
  email: string;
  name: string | null;
  password_hash: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  last_sent_at: Date;
}

export interface ConsumedVerification {
  id: number;
  email: string;
  name: string | null;
}

export type VerificationCheck =
  | { status: 'valid' }
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'too_many_attempts' }
  | { status: 'invalid' };

export function normalizeVerificationEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function generateVerificationCode(): string {
  return crypto
    .randomInt(0, 10 ** VERIFICATION_CODE_LENGTH)
    .toString()
    .padStart(VERIFICATION_CODE_LENGTH, '0');
}

export function hashVerificationCode(email: string, code: string): string {
  return crypto
    .createHash('sha256')
    .update(`${normalizeVerificationEmail(email)}:${code.trim()}`)
    .digest('hex');
}

function hashesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

function getExpiryDate(): Date {
  return new Date(Date.now() + VERIFICATION_EXPIRY_MINUTES * 60 * 1000);
}

/**
 * Stores (or replaces) a pending registration for the given email and returns
 * the plain-text code that must be emailed to the user. Only the hash is
 * persisted.
 */
export async function savePendingVerification(params: {
  email: string;
  name: string | null;
  passwordHash: string;
}): Promise<{ code: string; expiresAt: Date }> {
  await initDb();

  const email = normalizeVerificationEmail(params.email);
  const code = generateVerificationCode();
  const codeHash = hashVerificationCode(email, code);
  const expiresAt = getExpiryDate();

  await sql`
    INSERT INTO email_verifications (email, name, password_hash, code_hash, expires_at, attempts, last_sent_at)
    VALUES (${email}, ${params.name}, ${params.passwordHash}, ${codeHash}, ${expiresAt}, 0, CURRENT_TIMESTAMP)
    ON CONFLICT (email) DO UPDATE SET
      name = EXCLUDED.name,
      password_hash = EXCLUDED.password_hash,
      code_hash = EXCLUDED.code_hash,
      expires_at = EXCLUDED.expires_at,
      attempts = 0,
      last_sent_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `;

  return { code, expiresAt };
}

export async function getPendingVerification(email: string): Promise<PendingVerification | null> {
  await initDb();

  const rows = await sql`
    SELECT * FROM email_verifications
    WHERE email = ${normalizeVerificationEmail(email)}
    LIMIT 1
  `;

  return (rows[0] as PendingVerification | undefined) ?? null;
}

/**
 * Generates a fresh code for an existing pending registration.
 */
export async function rotatePendingVerification(
  pending: PendingVerification
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateVerificationCode();
  const codeHash = hashVerificationCode(pending.email, code);
  const expiresAt = getExpiryDate();

  await sql`
    UPDATE email_verifications SET
      code_hash = ${codeHash},
      expires_at = ${expiresAt},
      attempts = 0,
      last_sent_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${pending.id}
  `;

  return { code, expiresAt };
}

/**
 * Read-only-ish validation used to give the UI a precise error message.
 * A wrong code counts as a failed attempt.
 */
export async function checkVerificationCode(email: string, code: string): Promise<VerificationCheck> {
  await initDb();

  const normalizedEmail = normalizeVerificationEmail(email);
  const rows = await sql`
    SELECT * FROM email_verifications
    WHERE email = ${normalizedEmail}
    LIMIT 1
  `;

  const pending = rows[0] as PendingVerification | undefined;

  if (!pending) {
    return { status: 'missing' };
  }

  if (new Date(pending.expires_at).getTime() <= Date.now()) {
    return { status: 'expired' };
  }

  if (pending.attempts >= VERIFICATION_MAX_ATTEMPTS) {
    return { status: 'too_many_attempts' };
  }

  if (!hashesMatch(hashVerificationCode(normalizedEmail, code), pending.code_hash)) {
    await sql`
      UPDATE email_verifications
      SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${pending.id}
    `;
    return { status: 'invalid' };
  }

  return { status: 'valid' };
}

/**
 * Validates the code and, on success, creates the account plus its personal
 * workspace inside a transaction, then removes the pending verification.
 */
export async function verifyAndConsumeCode(
  email: string,
  code: string
): Promise<ConsumedVerification | null> {
  await initDb();

  const normalizedEmail = normalizeVerificationEmail(email);
  const rows = await sql`
    SELECT * FROM email_verifications
    WHERE email = ${normalizedEmail}
    LIMIT 1
  `;

  const pending = rows[0] as PendingVerification | undefined;

  if (!pending) {
    return null;
  }

  if (new Date(pending.expires_at).getTime() <= Date.now()) {
    return null;
  }

  if (pending.attempts >= VERIFICATION_MAX_ATTEMPTS) {
    return null;
  }

  if (!hashesMatch(hashVerificationCode(normalizedEmail, code), pending.code_hash)) {
    await sql`
      UPDATE email_verifications
      SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${pending.id}
    `;
    return null;
  }

  const existingUsers = await sql`
    SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1
  `;

  if (existingUsers.length > 0) {
    await sql`DELETE FROM email_verifications WHERE id = ${pending.id}`;
    return null;
  }

  const created = await sql.begin(async (tx) => {
    const users = await tx`
      INSERT INTO users (email, password_hash, name)
      VALUES (${normalizedEmail}, ${pending.password_hash}, ${pending.name})
      RETURNING id, email, name
    `;
    const user = users[0] as ConsumedVerification;

    const workspaces = await tx`
      INSERT INTO workspaces (name, description, created_by)
      VALUES ('Personal', 'Tu espacio de trabajo personal', ${user.id})
      RETURNING id
    `;
    const workspace = workspaces[0];

    await tx`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspace.id}, ${user.id}, 'owner')
      ON CONFLICT (workspace_id, user_id) DO NOTHING
    `;

    await tx`DELETE FROM email_verifications WHERE id = ${pending.id}`;

    return user;
  });

  return created;
}

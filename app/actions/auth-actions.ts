'use server';

import { auth, signIn, signOut } from '@/auth';
import { getUserByEmail, verifyPassword, hashPassword } from '@/lib/auth-utils';
import sql from '@/lib/db';
import { initWorkspaceDb } from '@/lib/workspace-db';
import { cookies } from 'next/headers';
import { sendPasswordResetEmail, sendVerificationEmail } from '@/lib/email';
import { hasValidMxRecords } from '@/lib/email-domain';
import {
  VERIFICATION_EXPIRY_MINUTES,
  VERIFICATION_RESEND_COOLDOWN_SECONDS,
  checkVerificationCode,
  getPendingVerification,
  rotatePendingVerification,
  savePendingVerification,
} from '@/lib/email-verification';
import {
  loginSchema,
  registerSchema,
  emailSchema,
  passwordSchema,
  formatZodError,
  createActionError,
  createActionSuccess,
  createValidationErrorResult,
  type ActionResult,
} from '@/lib/validations';
import crypto from 'crypto';

const AUTH_COOKIES = [
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
  'authjs.session-token',
  '__Secure-authjs.session-token',
  'workspace-id',
];

async function clearAuthCookies() {
  const cookieStore = await cookies();
  AUTH_COOKIES.forEach(name => cookieStore.delete(name));
}

export async function logoutAction() {
  await clearAuthCookies();
  await signOut({ redirectTo: '/' });
}

export async function updateOnboardingStatus(completed: boolean): Promise<ActionResult<void>> {
  const session = await auth();
  console.log('[UPDATE ONBOARDING] Session:', session?.user?.id, 'completed:', completed);
  
  if (!session?.user?.id) {
    console.log('[UPDATE ONBOARDING] No session user id');
    return createActionError<void>('Usuario no autenticado');
  }

  try {
    await initWorkspaceDb();
    const result = await sql`
      UPDATE users SET has_completed_onboarding = ${completed} WHERE id = ${Number(session.user.id)}
    `;
    console.log('[UPDATE ONBOARDING] Database updated successfully, rows affected:', result.count);
    return createActionSuccess(undefined);
  } catch (error) {
    console.error('[UPDATE ONBOARDING ERROR]', error);
    return createActionError<void>('Error al actualizar el estado del tutorial');
  }
}

// Test server action to verify server actions work
export async function testServerAction(): Promise<ActionResult<string>> {
  const session = await auth();
  console.log('[TEST SERVER ACTION] Session:', session?.user?.id);
  return createActionSuccess('Server action works!');
}

export async function loginAction(formData: FormData): Promise<ActionResult<{ isNewUser: boolean }>> {
  const rawData = {
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  };

  const validation = loginSchema.safeParse(rawData);
  if (!validation.success) {
    return createValidationErrorResult<{ isNewUser: boolean }>(formatZodError(validation.error));
  }

  try {
    const user = await getUserByEmail(validation.data.email);
    if (!user) {
      const pendingVerification = await getPendingVerification(validation.data.email);
      if (pendingVerification) {
        return createActionError<{ isNewUser: boolean }>(
          'Tu correo aún no está verificado. Usa el código que enviamos o vuelve a registrarte para recibir uno nuevo.'
        );
      }
      return createActionError<{ isNewUser: boolean }>('Credenciales inválidas');
    }

    const isValid = await verifyPassword(validation.data.password, user.passwordHash);
    if (!isValid) {
      return createActionError<{ isNewUser: boolean }>('Credenciales inválidas');
    }

    await clearAuthCookies();

    const result = await signIn('credentials', {
      email: validation.data.email,
      password: validation.data.password,
      redirect: false,
    });

    if (result?.error) {
      return createActionError<{ isNewUser: boolean }>('Credenciales inválidas');
    }

    // Check if this is the first login (no completed onboarding)
    const isNewUser = !user.hasCompletedOnboarding;

    return createActionSuccess({ isNewUser });
  } catch (error) {
    console.error('[LOGIN ERROR]', error);
    return createActionError<{ isNewUser: boolean }>('Error al iniciar sesión. Inténtalo de nuevo.');
  }
}

export interface RegisterResult {
  requiresVerification: true;
  email: string;
}

export async function registerAction(formData: FormData): Promise<ActionResult<RegisterResult>> {
  const rawData = {
    name: formData.get('name') as string,
    email: formData.get('email') as string,
    password: formData.get('password') as string,
    confirmPassword: formData.get('confirmPassword') as string,
  };

  const validation = registerSchema.safeParse(rawData);
  if (!validation.success) {
    return createValidationErrorResult<RegisterResult>(formatZodError(validation.error));
  }

  const { email, name, password } = validation.data;
  const domain = email.split('@')[1];

  try {
    const domainHasMx = await hasValidMxRecords(domain);

    if (!domainHasMx) {
      return createActionError<RegisterResult>(
        'No pudimos validar el dominio del correo. Revisa que esté bien escrito o usa otro correo.'
      );
    }

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return createActionError<RegisterResult>('Este correo electrónico ya está registrado');
    }

    const passwordHash = await hashPassword(password);
    const { code } = await savePendingVerification({
      email,
      name: name.trim(),
      passwordHash,
    });

    const emailResult = await sendVerificationEmail(
      email,
      code,
      name.trim(),
      VERIFICATION_EXPIRY_MINUTES
    );

    if (!emailResult.success) {
      console.error('[REGISTER] Failed to send verification email:', emailResult.error);
      return createActionError<RegisterResult>(
        'No pudimos enviar el correo de verificación. Inténtalo de nuevo en unos minutos.'
      );
    }

    return createActionSuccess<RegisterResult>({ requiresVerification: true, email });
  } catch (error) {
    console.error('[REGISTER ERROR]', error);
    return createActionError<RegisterResult>('Error al crear la cuenta. Inténtalo de nuevo.');
  }
}

export async function verifyEmailAction(formData: FormData): Promise<ActionResult<{ email: string }>> {
  const rawData = {
    email: formData.get('email') as string,
    code: (formData.get('code') as string) || '',
  };

  const emailValidation = emailSchema.safeParse(rawData.email);
  if (!emailValidation.success) {
    return createValidationErrorResult<{ email: string }>(formatZodError(emailValidation.error));
  }

  const email = emailValidation.data;
  const code = rawData.code.trim();

  if (!/^\d{6}$/.test(code)) {
    return createActionError<{ email: string }>(
      'Ingresa el código de 6 dígitos que enviamos a tu correo'
    );
  }

  try {
    const check = await checkVerificationCode(email, code);

    switch (check.status) {
      case 'missing':
        return createActionError<{ email: string }>(
          'No encontramos una verificación pendiente para este correo. Vuelve a registrarte.'
        );
      case 'expired':
        return createActionError<{ email: string }>(
          'El código ha expirado. Solicita uno nuevo.'
        );
      case 'too_many_attempts':
        return createActionError<{ email: string }>(
          'Demasiados intentos. Solicita un nuevo código.'
        );
      case 'invalid':
        return createActionError<{ email: string }>(
          'El código no es correcto. Revísalo e inténtalo de nuevo.'
        );
      case 'valid':
        break;
    }

    await clearAuthCookies();

    const result = await signIn('email-verification', {
      email,
      code,
      redirect: false,
    });

    if (result?.error) {
      return createActionError<{ email: string }>(
        'No pudimos verificar tu correo. Solicita un nuevo código e inténtalo de nuevo.'
      );
    }

    return createActionSuccess<{ email: string }>({ email });
  } catch (error) {
    console.error('[VERIFY EMAIL ERROR]', error);
    return createActionError<{ email: string }>(
      'No pudimos verificar tu correo. Inténtalo de nuevo.'
    );
  }
}

export async function resendVerificationCodeAction(
  formData: FormData
): Promise<ActionResult<{ email: string }>> {
  const emailValidation = emailSchema.safeParse(formData.get('email'));

  if (!emailValidation.success) {
    return createValidationErrorResult<{ email: string }>(formatZodError(emailValidation.error));
  }

  const email = emailValidation.data;

  try {
    const pending = await getPendingVerification(email);

    if (!pending) {
      return createActionError<{ email: string }>(
        'No encontramos una verificación pendiente para este correo. Vuelve a registrarte.'
      );
    }

    const elapsedSeconds = (Date.now() - new Date(pending.last_sent_at).getTime()) / 1000;
    const remainingSeconds = Math.ceil(
      VERIFICATION_RESEND_COOLDOWN_SECONDS - elapsedSeconds
    );

    if (remainingSeconds > 0) {
      return createActionError<{ email: string }>(
        `Espera ${remainingSeconds} segundo${remainingSeconds === 1 ? '' : 's'} antes de solicitar otro código.`
      );
    }

    const { code } = await rotatePendingVerification(pending);
    const emailResult = await sendVerificationEmail(
      email,
      code,
      pending.name || undefined,
      VERIFICATION_EXPIRY_MINUTES
    );

    if (!emailResult.success) {
      console.error('[RESEND VERIFICATION] Failed to send email:', emailResult.error);
      return createActionError<{ email: string }>(
        'No pudimos enviar el correo de verificación. Inténtalo de nuevo en unos minutos.'
      );
    }

    return createActionSuccess<{ email: string }>({ email });
  } catch (error) {
    console.error('[RESEND VERIFICATION ERROR]', error);
    return createActionError<{ email: string }>(
      'No pudimos reenviar el código. Inténtalo de nuevo.'
    );
  }
}

const RESET_TOKEN_EXPIRY_MINUTES = 30;
const RESET_TOKEN_BYTES = 32;

function generateResetToken(): string {
  return crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function forgotPasswordAction(formData: FormData): Promise<ActionResult<void>> {
  const rawData = {
    email: formData.get('email') as string,
  };

  const validation = emailSchema.safeParse(rawData.email);
  if (!validation.success) {
    return createValidationErrorResult<void>(formatZodError(validation.error));
  }

  try {
    await initWorkspaceDb();
    const user = await getUserByEmail(validation.data);

    // Always return success to prevent email enumeration
    if (!user) {
      return createActionSuccess<void>(undefined);
    }

    // Generate secure token
    const token = generateResetToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000);

    // Store token in database
    await sql`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${tokenHash}, ${expiresAt})
    `;

    // Send reset email
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;
    
    const emailResult = await sendPasswordResetEmail(user.email, resetUrl, user.name || undefined);
    
    if (!emailResult.success) {
      console.error('[FORGOT PASSWORD] Failed to send email:', emailResult.error);
      // Still return success to prevent email enumeration
    }

    return createActionSuccess<void>(undefined);
  } catch (error) {
    console.error('[FORGOT PASSWORD ERROR]', error);
    return createActionError<void>('Error al procesar la solicitud. Inténtalo de nuevo.');
  }
}

export async function resetPasswordAction(formData: FormData): Promise<ActionResult<void>> {
  const rawData = {
    token: formData.get('token') as string,
    password: formData.get('password') as string,
    confirmPassword: formData.get('confirmPassword') as string,
  };

  // Validate token format
  if (!rawData.token || rawData.token.length < 10) {
    return createActionError<void>('Token inválido o expirado');
  }

  // Validate password using the password schema
  const passwordValidation = passwordSchema.safeParse(rawData.password);
  if (!passwordValidation.success) {
    return createValidationErrorResult<void>(formatZodError(passwordValidation.error));
  }

  // Check passwords match
  if (rawData.password !== rawData.confirmPassword) {
    return createActionError<void>('Las contraseñas no coinciden');
  }

  try {
    await initWorkspaceDb();
    const tokenHash = hashToken(rawData.token);

    // Find valid token
    const tokens = await sql`
      SELECT * FROM password_reset_tokens
      WHERE token_hash = ${tokenHash}
        AND expires_at > NOW()
        AND used = FALSE
      LIMIT 1
    `;

    if (tokens.length === 0) {
      return createActionError<void>('Token inválido o expirado');
    }

    const tokenRecord = tokens[0];

    // Hash new password
    const passwordHash = await hashPassword(rawData.password);

    // Update user password
    await sql`
      UPDATE users SET password_hash = ${passwordHash} WHERE id = ${tokenRecord.user_id}
    `;

    // Mark token as used
    await sql`
      UPDATE password_reset_tokens SET used = TRUE WHERE id = ${tokenRecord.id}
    `;

    return createActionSuccess<void>(undefined);
  } catch (error) {
    console.error('[RESET PASSWORD ERROR]', error);
    return createActionError<void>('Error al restablecer la contraseña. Inténtalo de nuevo.');
  }
}
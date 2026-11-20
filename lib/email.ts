import { BrevoClient } from '@getbrevo/brevo';

type EmailProvider = 'resend' | 'brevo' | 'console';

export interface SendEmailParams {
  to: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

function getSenderEmail(): string {
  return process.env.SENDER_EMAIL || process.env.EMAIL_FROM || 'no-reply@planai.app';
}

function getSenderName(): string {
  return process.env.SENDER_NAME || 'PlanAI';
}

function getFromAddress(): string {
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  if (process.env.RESEND_FROM) return process.env.RESEND_FROM;

  const email = getSenderEmail();
  const name = getSenderName();
  return `${name} <${email}>`;
}

function isConfigured(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('...')) return false;
  if (trimmed === 'gsk_...' || trimmed === 'xkeysib-...') return false;
  return true;
}

function resolveProvider(): EmailProvider {
  const configured = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();

  if (configured === 'resend') {
    if (!isConfigured(process.env.RESEND_API_KEY)) {
      console.warn('[EMAIL] EMAIL_PROVIDER=resend but RESEND_API_KEY is missing. Falling back to console.');
      return 'console';
    }
    return 'resend';
  }

  if (configured === 'brevo') {
    if (!isConfigured(process.env.BREVO_API_KEY)) {
      console.warn('[EMAIL] EMAIL_PROVIDER=brevo but BREVO_API_KEY is missing. Falling back to console.');
      return 'console';
    }
    return 'brevo';
  }

  if (configured === 'console') {
    return 'console';
  }

  if (isConfigured(process.env.RESEND_API_KEY)) return 'resend';
  if (isConfigured(process.env.BREVO_API_KEY)) return 'brevo';
  return 'console';
}

let brevoClient: BrevoClient | null = null;

function getBrevoClient(): BrevoClient {
  if (!brevoClient) {
    brevoClient = new BrevoClient({ apiKey: process.env.BREVO_API_KEY! });
  }
  return brevoClient;
}

async function sendViaResend(params: SendEmailParams): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    return { success: false, error: 'RESEND_API_KEY no está configurada' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: getFromAddress(),
        to: [params.to],
        subject: params.subject,
        html: params.htmlContent,
        ...(params.textContent ? { text: params.textContent } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[EMAIL ERROR] Resend responded with ${response.status}: ${body}`);
      return { success: false, error: 'No se pudo enviar el correo' };
    }

    const data = (await response.json()) as { id?: string };
    console.log(`[EMAIL SENT] Provider: resend | To: ${params.to} | MessageId: ${data.id}`);
    return { success: true, messageId: data.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    console.error(`[EMAIL ERROR] Resend request failed: ${message}`);
    return { success: false, error: 'No se pudo enviar el correo' };
  }
}

async function sendViaBrevo(params: SendEmailParams): Promise<SendEmailResult> {
  try {
    const response = await getBrevoClient().transactionalEmails.sendTransacEmail({
      sender: { email: getSenderEmail(), name: getSenderName() },
      to: [{ email: params.to }],
      subject: params.subject,
      htmlContent: params.htmlContent,
      ...(params.textContent ? { textContent: params.textContent } : {}),
    });

    const messageId = (response as { messageId?: string }).messageId;
    console.log(`[EMAIL SENT] Provider: brevo | To: ${params.to} | MessageId: ${messageId}`);
    return { success: true, messageId };
  } catch (error) {
    const err = error as Error & { response?: { body?: { message?: string } } };
    const errorMessage = err.response?.body?.message || err.message || 'Error desconocido al enviar email';
    console.error(`[EMAIL ERROR] Provider: brevo | To: ${params.to} | Error: ${errorMessage}`);
    return { success: false, error: 'No se pudo enviar el correo' };
  }
}

function sendViaConsole(params: SendEmailParams): SendEmailResult {
  if (process.env.NODE_ENV === 'production') {
    console.error('[EMAIL] No transactional email provider is configured in production.');
    return { success: false, error: 'No hay un proveedor de correo configurado' };
  }

  console.warn('[EMAIL DEV FALLBACK] No hay un proveedor de correo disponible. El correo NO se envió.');
  console.warn(`[EMAIL DEV FALLBACK] To: ${params.to} | Subject: ${params.subject}`);
  console.warn('[EMAIL DEV FALLBACK] Contenido:\n' + (params.textContent || params.htmlContent));

  return { success: true, messageId: 'console-dev' };
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const provider = resolveProvider();

  if (provider === 'console') {
    return sendViaConsole(params);
  }

  const result =
    provider === 'resend' ? await sendViaResend(params) : await sendViaBrevo(params);

  if (result.success) {
    return result;
  }

  // In development, never block registration because a provider is
  // misconfigured: print the email (and its verification code) to the console.
  if (process.env.NODE_ENV !== 'production') {
    console.warn('[EMAIL] El proveedor de correo falló en desarrollo. Usando salida por consola.');
    return sendViaConsole(params);
  }

  return result;
}

export async function sendInvitationEmail(
  to: string,
  workspaceName: string,
  role: 'admin' | 'member',
  inviteUrl: string
): Promise<SendEmailResult> {
  const subject = `Invitación a unirte a ${workspaceName} en PlanAI`;
  const roleLabel = role === 'admin' ? 'Administrador' : 'Miembro';

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #1e293b; border-radius: 12px; padding: 32px;">
        <h1 style="color: #3b82f6; margin: 0 0 16px; font-size: 24px;">📨 Invitación a PlanAI</h1>
        <p style="color: #e2e8f0; margin: 0 0 24px; font-size: 16px;">Has sido invitado a unirte al workspace <strong>${workspaceName}</strong> en <strong>PlanAI</strong>.</p>
        <p style="color: #94a3b8; margin: 0 0 24px; font-size: 14px;">Rol: <strong style="color: #e2e8f0;">${roleLabel}</strong></p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${inviteUrl}" style="display: inline-block; background: #3b82f6; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">Aceptar invitación</a>
        </div>
        <p style="color: #64748b; font-size: 13px; margin: 0;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
        <p style="color: #3b82f6; font-size: 13px; word-break: break-all; margin: 8px 0 0;">${inviteUrl}</p>
        <hr style="border: none; border-top: 1px solid #334155; margin: 24px 0;">
        <p style="color: #64748b; font-size: 12px; margin: 0;">Esta invitación expira en 7 días. Si no esperabas esta invitación, puedes ignorar este correo.</p>
      </div>
    </body>
    </html>
  `;

  const textContent = `
    Invitación a PlanAI
    
    Has sido invitado a unirte al workspace "${workspaceName}" en PlanAI.
    Rol: ${roleLabel}
    
    Para aceptar la invitación, visita: ${inviteUrl}
    
    Esta invitación expira en 7 días. Si no esperabas esta invitación, puedes ignorar este correo.
  `;

  return sendEmail({ to, subject, htmlContent, textContent });
}

export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  userName?: string
): Promise<SendEmailResult> {
  const subject = 'Restablece tu contraseña en PlanAI';
  const displayName = userName || 'Usuario';

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #1e293b; border-radius: 12px; padding: 32px;">
        <h1 style="color: #3b82f6; margin: 0 0 16px; font-size: 24px;">🔐 Restablecer contraseña</h1>
        <p style="color: #e2e8f0; margin: 0 0 24px; font-size: 16px;">Hola <strong>${displayName}</strong>,</p>
        <p style="color: #94a3b8; margin: 0 0 24px; font-size: 14px;">Recibimos una solicitud para restablecer la contraseña de tu cuenta en <strong>PlanAI</strong>.</p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetUrl}" style="display: inline-block; background: #3b82f6; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">Restablecer contraseña</a>
        </div>
        <p style="color: #64748b; font-size: 13px; margin: 0;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
        <p style="color: #3b82f6; font-size: 13px; word-break: break-all; margin: 8px 0 0;">${resetUrl}</p>
        <hr style="border: none; border-top: 1px solid #334155; margin: 24px 0;">
        <p style="color: #ef4444; font-size: 13px; margin: 0 0 8px;"><strong>Importante:</strong> Este enlace expira en 30 minutos.</p>
        <p style="color: #64748b; font-size: 12px; margin: 0;">Si no solicitaste restablecer tu contraseña, puedes ignorar este correo. Tu cuenta permanecerá segura.</p>
      </div>
    </body>
    </html>
  `;

  const textContent = `
    Restablecer contraseña - PlanAI
    
    Hola ${displayName},
    
    Recibimos una solicitud para restablecer la contraseña de tu cuenta en PlanAI.
    
    Para restablecer tu contraseña, visita: ${resetUrl}
    
    Importante: Este enlace expira en 30 minutos.
    
    Si no solicitaste restablecer tu contraseña, puedes ignorar este correo. Tu cuenta permanecerá segura.
  `;

  return sendEmail({ to, subject, htmlContent, textContent });
}

export async function sendVerificationEmail(
  to: string,
  code: string,
  userName?: string,
  expiresInMinutes = 15
): Promise<SendEmailResult> {
  const subject = `${code} es tu código de verificación de PlanAI`;
  const displayName = userName || 'Hola';

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 24px; background: #020617; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="max-width: 560px; margin: 0 auto; background: linear-gradient(160deg, #0f172a 0%, #1e1b4b 100%); border: 1px solid rgba(167, 139, 250, 0.25); border-radius: 20px; padding: 40px 32px; box-shadow: 0 24px 60px rgba(76, 29, 149, 0.35);">
        <div style="text-align: center; margin-bottom: 28px;">
          <span style="display: inline-block; width: 52px; height: 52px; line-height: 52px; border-radius: 14px; background: rgba(139, 92, 246, 0.18); border: 1px solid rgba(167, 139, 250, 0.35); color: #c4b5fd; font-size: 26px;">✉</span>
        </div>
        <h1 style="margin: 0 0 12px; font-size: 24px; text-align: center; color: #f8fafc;">Verifica tu correo</h1>
        <p style="margin: 0 0 8px; font-size: 15px; line-height: 1.6; color: #cbd5e1; text-align: center;">
          ${displayName}, usa el siguiente código para activar tu cuenta de PlanAI.
        </p>
        <div style="margin: 32px 0; padding: 20px; border-radius: 16px; background: rgba(139, 92, 246, 0.12); border: 1px solid rgba(167, 139, 250, 0.3); text-align: center;">
          <span style="display: block; font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: #a78bfa; margin-bottom: 10px;">Tu código</span>
          <span style="display: block; font-size: 38px; font-weight: 700; letter-spacing: 0.35em; color: #f5f3ff; font-family: 'SFMono-Regular', Consolas, monospace;">${code}</span>
        </div>
        <p style="margin: 0 0 8px; font-size: 14px; line-height: 1.6; color: #94a3b8; text-align: center;">
          El código expira en ${expiresInMinutes} minutos. Si no creaste una cuenta en PlanAI, puedes ignorar este correo.
        </p>
        <hr style="border: none; border-top: 1px solid rgba(148, 163, 184, 0.15); margin: 28px 0 20px;">
        <p style="margin: 0; font-size: 12px; line-height: 1.6; color: #64748b; text-align: center;">
          Por seguridad, nunca compartas este código con nadie. El equipo de PlanAI nunca te lo pedirá.
        </p>
      </div>
    </body>
    </html>
  `;

  const textContent = `
    Verifica tu correo - PlanAI

    ${displayName}, usa el siguiente código para activar tu cuenta:

    ${code}

    El código expira en ${expiresInMinutes} minutos. Si no creaste una cuenta en PlanAI, puedes ignorar este correo.
    Por seguridad, nunca compartas este código con nadie.
  `;

  return sendEmail({ to, subject, htmlContent, textContent });
}

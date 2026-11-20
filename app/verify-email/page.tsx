'use client';

import { useEffect, useState, FormEvent, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Logo } from '@/components/Logo';
import { verifyEmailAction, resendVerificationCodeAction } from '@/app/actions/auth-actions';
import { useGlobalToast, useActionError } from '@/components/ui/useToast';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  MailCheck,
  Send,
  ShieldCheck,
} from 'lucide-react';

const RESEND_COOLDOWN_SECONDS = 60;

function VerifyEmailForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const email = (searchParams.get('email') || '').trim().toLowerCase();
  const hasValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const [code, setCode] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [verified, setVerified] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { showSuccess } = useGlobalToast();
  const { handleActionResult } = useActionError();

  useEffect(() => {
    if (cooldown <= 0) return;

    const timer = setInterval(() => {
      setCooldown((value) => (value > 0 ? value - 1 : 0));
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldown]);

  const handleCodeChange = (value: string) => {
    setCode(value.replace(/\D/g, '').slice(0, 6));
    setFormError(null);
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!hasValidEmail) return;

    if (!/^\d{6}$/.test(code)) {
      setFormError('Ingresa el código de 6 dígitos que enviamos a tu correo.');
      return;
    }

    setIsVerifying(true);

    try {
      const formData = new FormData();
      formData.append('email', email);
      formData.append('code', code);

      const result = await verifyEmailAction(formData);

      if (!handleActionResult(result)) {
        return;
      }

      setVerified(true);
      showSuccess('Correo verificado', 'Tu cuenta está activa. Redirigiendo al dashboard...');

      setTimeout(() => {
        router.push('/dashboard?new_user=true');
        router.refresh();
      }, 1200);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResend = async () => {
    if (!hasValidEmail || cooldown > 0 || isResending) return;

    setIsResending(true);

    try {
      const formData = new FormData();
      formData.append('email', email);

      const result = await resendVerificationCodeAction(formData);

      if (!handleActionResult(result)) {
        return;
      }

      setCooldown(RESEND_COOLDOWN_SECONDS);
      showSuccess('Código reenviado', `Revisa la bandeja de entrada de ${email}`);
    } finally {
      setIsResending(false);
    }
  };

  if (!hasValidEmail) {
    return (
      <div className="min-h-screen bg-[#020617] text-slate-100 flex items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[32rem] h-[32rem] bg-violet-600/10 rounded-full blur-3xl" />
        </div>
        <div className="relative w-full max-w-md bg-slate-900/70 border border-slate-800/80 rounded-2xl p-8 shadow-2xl backdrop-blur-xl text-center">
          <div className="w-16 h-16 rounded-full bg-red-500/15 border border-red-500/20 flex items-center justify-center mx-auto mb-6">
            <AlertCircle className="w-8 h-8 text-red-400" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-heading font-semibold mb-3">Falta el correo a verificar</h1>
          <p className="text-slate-400 mb-6 text-sm">
            Abre el enlace desde el registro o vuelve a crear tu cuenta para recibir un código nuevo.
          </p>
          <Link
            href="/register"
            className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-medium rounded-xl transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Volver al registro
          </Link>
        </div>
      </div>
    );
  }

  if (verified) {
    return (
      <div className="min-h-screen bg-[#020617] text-slate-100 flex items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[32rem] h-[32rem] bg-violet-600/15 rounded-full blur-3xl" />
        </div>
        <div className="relative w-full max-w-md bg-slate-900/70 border border-slate-800/80 rounded-2xl p-8 shadow-2xl backdrop-blur-xl text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-8 h-8 text-emerald-400" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-heading font-semibold mb-3">¡Correo verificado!</h1>
          <p className="text-slate-400 mb-6 text-sm">
            Tu cuenta está activa. Te estamos redirigiendo al dashboard...
          </p>
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-violet-500 border-t-transparent mx-auto" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[34rem] h-[34rem] bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        <div className="bg-slate-900/70 border border-slate-800/80 rounded-2xl p-8 shadow-2xl backdrop-blur-xl ring-1 ring-white/5 animate-fade-in">
          <div className="text-center mb-8">
            <Link
              href="/"
              className="inline-flex items-center gap-3 text-2xl font-heading font-bold tracking-tight mb-6"
            >
              <Logo size={44} priority />
              <span className="bg-gradient-to-r from-white via-slate-200 to-violet-400 bg-clip-text text-transparent">
                PlanAI
              </span>
            </Link>

            <div className="w-16 h-16 rounded-2xl bg-violet-500/15 border border-violet-400/25 flex items-center justify-center mx-auto mb-5">
              <MailCheck className="w-8 h-8 text-violet-300" aria-hidden="true" />
            </div>

            <h1 className="text-2xl font-heading font-semibold mb-2 bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent">
              Verifica tu correo
            </h1>
            <p className="text-slate-400 text-sm">
              Enviamos un código de 6 dígitos a
            </p>
            <p className="text-violet-300 text-sm font-medium break-all mt-1">{email}</p>
          </div>

          <form onSubmit={handleVerify} className="space-y-4">
            <div>
              <label
                htmlFor="code"
                className="block text-xs font-semibold tracking-wide text-slate-300 mb-1.5"
              >
                Código de verificación
              </label>
              <input
                id="code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => handleCodeChange(event.target.value)}
                className="w-full bg-slate-950/90 border border-slate-800 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 text-slate-100 placeholder:text-slate-600 rounded-xl px-4 py-3 text-center text-2xl tracking-[0.45em] font-mono transition-all duration-200"
                placeholder="000000"
                aria-invalid={Boolean(formError)}
                aria-describedby={formError ? 'code-error' : undefined}
              />
              {formError && (
                <p id="code-error" className="mt-2 text-sm text-red-400 flex items-center gap-1">
                  <AlertCircle className="w-4 h-4" aria-hidden="true" />
                  {formError}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={isVerifying || code.length !== 6}
              className="w-full bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-semibold rounded-xl py-3 shadow-lg shadow-violet-600/25 hover:shadow-violet-500/40 transition-all duration-200 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isVerifying ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                  Verificando...
                </>
              ) : (
                'Verificar y activar cuenta'
              )}
            </button>

            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleResend}
                disabled={cooldown > 0 || isResending}
                className="inline-flex items-center gap-2 text-sm font-medium text-violet-300 hover:text-violet-200 transition-colors disabled:text-slate-500 disabled:cursor-not-allowed"
              >
                {isResending ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="w-4 h-4" aria-hidden="true" />
                )}
                {cooldown > 0 ? `Reenviar código en ${cooldown}s` : 'Reenviar código'}
              </button>
            </div>
          </form>

          <div className="mt-6 border-t border-slate-800/80 pt-5 space-y-3">
            <p className="flex items-start gap-2 text-xs text-slate-500 leading-relaxed">
              <ShieldCheck className="w-4 h-4 text-violet-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
              El código expira en 15 minutos. Nunca compartas este código con nadie.
            </p>
            <p className="text-center text-sm text-slate-500">
              ¿Correo incorrecto?{' '}
              <Link href="/register" className="text-violet-400 hover:text-violet-300 font-medium">
                Volver al registro
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#020617] flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-violet-500 border-t-transparent" />
        </div>
      }
    >
      <VerifyEmailForm />
    </Suspense>
  );
}

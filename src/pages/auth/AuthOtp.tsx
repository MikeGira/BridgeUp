import { useState, useRef, useEffect, KeyboardEvent, ClipboardEvent } from 'react';
import { useLocation } from 'wouter';
import { ChevronLeft, Loader2, RefreshCw, CheckCircle } from 'lucide-react';
import { authApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

const OTP_LENGTH = 6;

export default function AuthOtp() {
  const [, navigate] = useLocation();
  const { login } = useAuthStore();
  const { toast } = useToast();

  const phone = sessionStorage.getItem('bridgeup_verify_phone') || '';

  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [loading, setLoading] = useState(false);
  const [verified, setVerified] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(30);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (!phone) { navigate('/login'); return; }
    refs.current[0]?.focus();
  }, [phone, navigate]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  function updateDigit(index: number, value: string) {
    const clean = value.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = clean;
    setDigits(next);
    if (clean && index < OTP_LENGTH - 1) refs.current[index + 1]?.focus();
    if (next.every((d) => d) && next.join('').length === OTP_LENGTH) {
      verifyCode(next.join(''));
    }
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    const next = [...digits];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    if (pasted.length === OTP_LENGTH) verifyCode(pasted);
    else refs.current[Math.min(pasted.length, OTP_LENGTH - 1)]?.focus();
  }

  async function verifyCode(code: string) {
    if (loading || verified) return;
    setLoading(true);
    try {
      const { token, user } = await authApi.verifyOtp(phone, code);
      setVerified(true);
      login(token, user);
      setTimeout(() => navigate('/home'), 600);
    } catch (err: unknown) {
      toast({
        title: 'Incorrect code',
        description: err instanceof Error ? err.message : 'Please check the code and try again.',
        variant: 'destructive',
      });
      setDigits(Array(OTP_LENGTH).fill(''));
      refs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    if (resendCooldown > 0) return;
    try {
      await authApi.sendOtp(phone);
      setResendCooldown(30);
      toast({ title: 'New code sent', description: `Sent to ${phone.slice(0, -4)}****` });
    } catch (err: unknown) {
      toast({
        title: 'Could not resend',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }

  const maskedPhone = phone ? phone.slice(0, 4) + '****' + phone.slice(-4) : '';

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <div className="flex items-center px-4 pt-12 pb-4">
        <button
          type="button"
          onClick={() => navigate('/login')}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted transition-colors"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 flex flex-col px-6 pt-4">
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight mb-2">Verify your number</h1>
          <p className="text-muted-foreground">
            We sent a {OTP_LENGTH}-digit code to{' '}
            <span className="font-medium text-foreground">{maskedPhone}</span>
          </p>
        </div>

        {/* OTP input boxes */}
        <div className="flex gap-3 justify-center mb-8">
          {digits.map((digit, i) => (
            <div key={i} className="relative">
              <input
                ref={(el) => { refs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => updateDigit(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                onPaste={i === 0 ? handlePaste : undefined}
                disabled={loading || verified}
                className={[
                  'w-12 h-14 text-center text-xl font-bold rounded-xl border-2 bg-card',
                  'focus:outline-none focus:ring-0 transition-all',
                  verified
                    ? 'border-green-500 bg-green-50 text-green-700'
                    : digit
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border text-foreground',
                  'disabled:opacity-60',
                ].join(' ')}
              />
            </div>
          ))}
        </div>

        {/* Status */}
        <div className="flex justify-center mb-6 h-10">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Verifying...
            </div>
          )}
          {verified && (
            <div className="flex items-center gap-2 text-sm text-green-600 font-medium">
              <CheckCircle className="w-4 h-4" />
              Verified! Taking you in...
            </div>
          )}
        </div>

        {/* Manual submit */}
        {!loading && !verified && (
          <Button
            size="lg"
            className="w-full h-14 text-base font-semibold rounded-xl mb-4"
            onClick={() => verifyCode(digits.join(''))}
            disabled={digits.filter(Boolean).length !== OTP_LENGTH}
          >
            Verify
          </Button>
        )}

        {/* Resend */}
        <button
          type="button"
          onClick={() => void resend()}
          disabled={resendCooldown > 0}
          className="flex items-center gap-2 mx-auto text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
        </button>

        <p className="text-xs text-center text-muted-foreground mt-8 leading-relaxed">
          Having trouble? Make sure your phone has mobile signal or Wi-Fi.
          Codes expire in 5 minutes.
        </p>
      </div>
    </div>
  );
}

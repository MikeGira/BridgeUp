import { useState, useRef, useEffect, KeyboardEvent, ClipboardEvent } from 'react';
import { useLocation } from 'wouter';
import { ChevronLeft, Loader2, RefreshCw, CheckCircle } from 'lucide-react';
import { authApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useToast } from '@/hooks/use-toast';

const OTP_LENGTH = 6;

export default function AuthOtp() {
  const [, navigate] = useLocation();
  const { login } = useAuthStore();
  const { toast } = useToast();

  const phone = sessionStorage.getItem('bridgeup_verify_phone') || localStorage.getItem('bridgeup_verify_phone') || '';

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
      setTimeout(() => navigate('/home'), 500);
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
      toast({ title: 'New code sent', description: `Sent to ${phone.slice(0, 4)}****${phone.slice(-4)}` });
    } catch (err: unknown) {
      toast({
        title: 'Could not resend',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }

  const maskedPhone = phone ? phone.slice(0, 4) + '****' + phone.slice(-4) : '';
  const allFilled = digits.filter(Boolean).length === OTP_LENGTH;

  return (
    <div style={{
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f4f4f6',
      padding: '24px 16px',
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <div style={{
        background: '#ffffff',
        borderRadius: 20,
        padding: '36px 28px 40px',
        width: '100%',
        maxWidth: 420,
        boxShadow: '0 4px 32px rgba(0,0,0,0.10)',
        boxSizing: 'border-box',
      }}>

        {/* Back + brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 28 }}>
          <button
            type="button"
            onClick={() => navigate('/login')}
            style={{
              width: 36, height: 36, borderRadius: 10, border: '1.5px solid #e4e4e7',
              background: '#fafafa', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', flexShrink: 0,
            }}
          >
            <ChevronLeft style={{ width: 18, height: 18, color: '#09090b' }} />
          </button>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', paddingRight: 44 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 10,
              background: 'linear-gradient(135deg,#2563eb,#1d4ed8)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 3px 10px rgba(37,99,235,0.3)',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <span style={{ fontSize: 18, fontWeight: 800, color: '#09090b', letterSpacing: '-0.3px' }}>BridgeUp</span>
          </div>
        </div>

        {/* Heading */}
        <div style={{ marginBottom: 28, textAlign: 'center' }}>
          {verified ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#dcfce7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CheckCircle style={{ width: 28, height: 28, color: '#16a34a' }} />
              </div>
              <p style={{ fontSize: 20, fontWeight: 700, color: '#09090b', margin: 0 }}>You're in!</p>
              <p style={{ fontSize: 13, color: '#71717a', margin: 0 }}>Taking you to BridgeUp…</p>
            </div>
          ) : (
            <>
              <p style={{ fontSize: 22, fontWeight: 700, color: '#09090b', margin: '0 0 6px', letterSpacing: '-0.3px' }}>
                Enter your code
              </p>
              <p style={{ fontSize: 14, color: '#71717a', margin: 0 }}>
                We sent a {OTP_LENGTH}-digit code to{' '}
                <span style={{ fontWeight: 600, color: '#09090b' }}>{maskedPhone}</span>
              </p>
            </>
          )}
        </div>

        {/* OTP boxes */}
        {!verified && (
          <>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 6 }}>
              {digits.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => { refs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => updateDigit(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  onPaste={i === 0 ? handlePaste : undefined}
                  disabled={loading}
                  style={{
                    width: 48, height: 56,
                    textAlign: 'center',
                    fontSize: 22,
                    fontWeight: 700,
                    borderRadius: 12,
                    border: `2px solid ${verified ? '#22c55e' : digit ? '#2563eb' : '#e4e4e7'}`,
                    background: digit ? '#eff6ff' : '#f9f9f9',
                    color: '#09090b',
                    outline: 'none',
                    transition: 'border-color 0.15s, background 0.15s',
                    fontFamily: 'inherit',
                  }}
                />
              ))}
            </div>

            {/* Loading indicator */}
            <div style={{ height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
              {loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#71717a', fontSize: 13 }}>
                  <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} />
                  Verifying…
                </div>
              )}
            </div>

            {/* Verify button */}
            <button
              type="button"
              onClick={() => verifyCode(digits.join(''))}
              disabled={!allFilled || loading}
              style={{
                width: '100%',
                height: 52,
                borderRadius: 12,
                border: 'none',
                background: allFilled && !loading ? '#000000' : '#e4e4e7',
                color: allFilled && !loading ? '#ffffff' : '#a1a1aa',
                fontSize: 15,
                fontWeight: 700,
                cursor: allFilled && !loading ? 'pointer' : 'not-allowed',
                marginBottom: 16,
                fontFamily: 'inherit',
                transition: 'background 0.15s',
              }}
            >
              Verify
            </button>

            {/* Resend */}
            <button
              type="button"
              onClick={() => void resend()}
              disabled={resendCooldown > 0}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                margin: '0 auto',
                background: 'none',
                border: 'none',
                cursor: resendCooldown > 0 ? 'default' : 'pointer',
                color: resendCooldown > 0 ? '#a1a1aa' : '#2563eb',
                fontSize: 13,
                fontWeight: 500,
                fontFamily: 'inherit',
              }}
            >
              <RefreshCw style={{ width: 13, height: 13 }} />
              {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
            </button>
          </>
        )}

        {/* Help text */}
        {!verified && (
          <p style={{ fontSize: 12, color: '#a1a1aa', textAlign: 'center', marginTop: 24, marginBottom: 0, lineHeight: 1.6 }}>
            Having trouble? Check your signal. Codes expire in 5 minutes.
          </p>
        )}
      </div>
    </div>
  );
}

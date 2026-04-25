import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { Loader2, Mail } from 'lucide-react';
import { authApi } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

const COUNTRIES = [
  { code: 'RW', flag: '🇷🇼', name: 'Rwanda',        dial: '+250' },
  { code: 'KE', flag: '🇰🇪', name: 'Kenya',         dial: '+254' },
  { code: 'UG', flag: '🇺🇬', name: 'Uganda',        dial: '+256' },
  { code: 'TZ', flag: '🇹🇿', name: 'Tanzania',      dial: '+255' },
  { code: 'NG', flag: '🇳🇬', name: 'Nigeria',       dial: '+234' },
  { code: 'GH', flag: '🇬🇭', name: 'Ghana',         dial: '+233' },
  { code: 'ZA', flag: '🇿🇦', name: 'South Africa',  dial: '+27'  },
  { code: 'ET', flag: '🇪🇹', name: 'Ethiopia',      dial: '+251' },
  { code: 'CM', flag: '🇨🇲', name: 'Cameroon',      dial: '+237' },
  { code: 'SN', flag: '🇸🇳', name: 'Senegal',       dial: '+221' },
  { code: 'CD', flag: '🇨🇩', name: 'DR Congo',      dial: '+243' },
  { code: 'MA', flag: '🇲🇦', name: 'Morocco',       dial: '+212' },
  { code: 'EG', flag: '🇪🇬', name: 'Egypt',         dial: '+20'  },
  { code: 'CA', flag: '🇨🇦', name: 'Canada',        dial: '+1'   },
  { code: 'US', flag: '🇺🇸', name: 'United States', dial: '+1'   },
  { code: 'GB', flag: '🇬🇧', name: 'United Kingdom',dial: '+44'  },
  { code: 'FR', flag: '🇫🇷', name: 'France',        dial: '+33'  },
  { code: 'DE', flag: '🇩🇪', name: 'Germany',       dial: '+49'  },
  { code: 'BE', flag: '🇧🇪', name: 'Belgium',       dial: '+32'  },
  { code: 'AU', flag: '🇦🇺', name: 'Australia',     dial: '+61'  },
  { code: 'IN', flag: '🇮🇳', name: 'India',         dial: '+91'  },
  { code: 'AE', flag: '🇦🇪', name: 'UAE',           dial: '+971' },
  { code: 'SA', flag: '🇸🇦', name: 'Saudi Arabia',  dial: '+966' },
];

function isValidMobileNumber(digits: string, dial: string): boolean {
  const min = dial === '+1' ? 10 : 6;
  return digits.length >= min && digits.length <= 15;
}

// ─── Desktop input helpers ─────────────────────────────────────────────────

function isEmailInput(val: string): boolean {
  return val.includes('@');
}

function parseDesktopPhone(val: string): string {
  const stripped = val.trim().replace(/[\s\-\(\)\.]/g, '');
  if (stripped.startsWith('+')) return stripped;
  // bare digits ≥10: assume North American +1
  if (/^\d{10,11}$/.test(stripped)) return '+1' + stripped.slice(-10);
  return '';
}

function isValidDesktopInput(val: string): boolean {
  if (isEmailInput(val)) {
    return val.includes('.') && val.indexOf('@') > 0 && val.length > 5;
  }
  const phone = parseDesktopPhone(val);
  const digits = phone.replace(/\D/g, '');
  return phone.startsWith('+') && digits.length >= 8 && digits.length <= 15;
}

// ──────────────────────────────────────────────────────────────────────────

const MOBILE_EXAMPLES: Record<string, string> = {
  '+250': '788 123 456',
  '+254': '712 345 678',
  '+1':   '416 555 0100',
  '+44':  '7700 900 123',
  '+33':  '6 12 34 56 78',
};

export default function AuthPhone() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // ── Viewport ──────────────────────────────────────────────────────────────
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 640
  );
  useEffect(() => {
    const handler = () => setIsDesktop(window.innerWidth >= 640);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // ── Mobile state ──────────────────────────────────────────────────────────
  const [dialCode, setDialCode] = useState('+250');
  const [mobileNumber, setMobileNumber] = useState('');
  const [mobileTouched, setMobileTouched] = useState(false);

  const selectedCountry = COUNTRIES.find((c) => c.dial === dialCode) ?? COUNTRIES[0];
  const mobileDigits = mobileNumber.replace(/\D/g, '');
  const mobilePhone  = dialCode + mobileDigits;
  const mobileReady  = isValidMobileNumber(mobileDigits, dialCode);
  const mobileShowError = mobileTouched && !mobileReady && mobileDigits.length > 0;
  const mobilePlaceholder = MOBILE_EXAMPLES[dialCode] || '7XX XXX XXX';

  // ── Desktop state ─────────────────────────────────────────────────────────
  const [desktopInput, setDesktopInput] = useState('');
  const [desktopTouched, setDesktopTouched] = useState(false);

  const desktopIsEmail = isEmailInput(desktopInput);
  const desktopReady   = desktopInput.length > 0 && isValidDesktopInput(desktopInput);
  const desktopShowError = desktopTouched && desktopInput.length > 0 && !desktopReady && !desktopIsEmail;

  // ── Shared ────────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);

  async function sendOtp(fullPhone: string) {
    setLoading(true);
    try {
      await authApi.sendOtp(fullPhone);
      sessionStorage.setItem('bridgeup_verify_phone', fullPhone);
      navigate('/verify');
    } catch (err: unknown) {
      toast({
        title: 'Could not send code',
        description: err instanceof Error ? err.message : 'Please check your number and try again.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleMobileSend() {
    setMobileTouched(true);
    if (!mobileReady || loading) return;
    await sendOtp(mobilePhone);
  }

  async function handleDesktopSend() {
    setDesktopTouched(true);
    if (loading) return;
    if (desktopIsEmail) {
      toast({ title: 'Email sign-in coming soon', description: 'Use your phone number for now.' });
      return;
    }
    if (!desktopReady) return;
    await sendOtp(parseDesktopPhone(desktopInput));
  }

  function comingSoon(label: string) {
    toast({ title: `${label} sign-in coming soon`, description: 'Use your phone number for now.' });
  }

  const ctaDisabled = isDesktop
    ? (!desktopReady && !desktopIsEmail) || loading
    : !mobileReady || loading;
  const ctaReady = isDesktop ? (desktopReady || desktopIsEmail) : mobileReady;

  return (
    <div className="bu-auth-root">

      {/* ── Dark hero (mobile only — hidden on desktop via CSS) ── */}
      <div className="bu-hero">
        <div className="bu-logo-wrap">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <h1 className="bu-title">BridgeUp</h1>
        <p className="bu-subtitle">Connect with help in your community —<br />food, shelter, jobs, medical care and more.</p>
        <div className="bu-stats">
          {[{ n: '2,400+', l: 'Helped' }, { n: '12', l: 'Cities' }, { n: '800+', l: 'Helpers' }].map((s) => (
            <div key={s.l} className="bu-stat">
              <span className="bu-stat-n">{s.n}</span>
              <span className="bu-stat-l">{s.l}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Card ─────────────────────────────────────────────────────────── */}
      <div className="bu-card">

        {/* Desktop brand logo (hidden on mobile via CSS) */}
        <div className="bu-desktop-brand">
          <div className="bu-desktop-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="bu-desktop-name">BridgeUp</span>
        </div>

        {/* ── DESKTOP input area ─────────────────────────────────────────── */}
        {isDesktop ? (
          <>
            <h2 className="bu-card-title">What's your phone number or email?</h2>
            <p className="bu-card-sub">We'll send you a verification code via SMS</p>

            <input
              type="text"
              inputMode="text"
              autoComplete="tel email"
              placeholder="+1 416 555 0100 or you@example.com"
              value={desktopInput}
              onChange={(e) => { setDesktopInput(e.target.value); setDesktopTouched(false); }}
              onBlur={() => setDesktopTouched(true)}
              onKeyDown={(e) => e.key === 'Enter' && void handleDesktopSend()}
              className={`bu-phone-input bu-input-solo${desktopShowError ? ' bu-phone-input-error' : ''}`}
              autoFocus
              style={{ marginBottom: 8 }}
            />

            {desktopShowError && (
              <p className="bu-field-error">
                Enter a valid phone (include country code, e.g. +1) or email address.
              </p>
            )}
            {!desktopShowError && desktopInput.length === 0 && (
              <p className="bu-hint">Example: +1 416 555 0100 · +250 788 123 456 · you@email.com</p>
            )}
            {!desktopShowError && desktopInput.length > 0 && <div style={{ marginBottom: 12 }} />}

            <button
              className={`bu-btn${ctaReady ? ' bu-btn-active' : ''}`}
              onClick={() => void handleDesktopSend()}
              disabled={ctaDisabled}
            >
              {loading
                ? <><Loader2 className="bu-spin" />&nbsp;Sending code…</>
                : <>Continue &nbsp;→</>}
            </button>
          </>
        ) : (
          /* ── MOBILE input area ─────────────────────────────────────────── */
          <>
            <h2 className="bu-card-title">Enter your number</h2>
            <p className="bu-card-sub">We'll send a 6-digit verification code via SMS</p>

            <div className="bu-input-row">
              <div className="bu-cc-wrap">
                <div className="bu-cc-display" aria-hidden="true">
                  <span className="bu-cc-flag">{selectedCountry.flag}</span>
                  <span className="bu-cc-code">{dialCode}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
                </div>
                <select
                  className="bu-cc-select"
                  value={dialCode}
                  onChange={(e) => { setDialCode(e.target.value); setMobileTouched(false); setMobileNumber(''); }}
                  aria-label="Select country code"
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.dial}>
                      {c.flag}  {c.name}  ({c.dial})
                    </option>
                  ))}
                </select>
              </div>

              <input
                type="tel"
                inputMode="numeric"
                placeholder={mobilePlaceholder}
                value={mobileNumber}
                onChange={(e) => { setMobileNumber(e.target.value.replace(/[^\d\s\-]/g, '')); setMobileTouched(false); }}
                onBlur={() => setMobileTouched(true)}
                onKeyDown={(e) => e.key === 'Enter' && void handleMobileSend()}
                className={`bu-phone-input${mobileShowError ? ' bu-phone-input-error' : ''}`}
                autoFocus
                autoComplete="tel-local"
                name="phone"
                aria-invalid={mobileShowError}
              />
            </div>

            {mobileShowError && (
              <p className="bu-field-error">
                Please enter a valid phone number for {selectedCountry.name} ({dialCode}).
              </p>
            )}
            {!mobileShowError && (
              <p className="bu-hint">
                Example for {selectedCountry.name}: {dialCode} {mobilePlaceholder}
              </p>
            )}

            <button
              className={`bu-btn${mobileReady ? ' bu-btn-active' : ''}`}
              onClick={() => void handleMobileSend()}
              disabled={!mobileReady || loading}
            >
              {loading
                ? <><Loader2 className="bu-spin" />&nbsp;Sending code…</>
                : <>Continue &nbsp;→</>}
            </button>
          </>
        )}

        {/* ── Social sign-in (same on both desktop and mobile) ─────────── */}
        <div className="bu-divider">or sign in with</div>

        <div className="bu-social-btns">
          <button type="button" className="bu-social-btn" onClick={() => comingSoon('Google')}>
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
          <button type="button" className="bu-social-btn" onClick={() => comingSoon('Apple')}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.4c1.32.07 2.22.79 3.02.8.77.01 2.18-.82 3.74-.7 1.28.1 2.35.58 3.19 1.49-2.86 1.7-2.44 5.72.01 7.06-.5 1.45-1.22 2.88-1.96 4.23zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
            </svg>
            Continue with Apple
          </button>
          <button type="button" className="bu-social-btn" onClick={() => comingSoon('Email')}>
            <Mail size={20} />
            Continue with Email
          </button>
        </div>

        <p className="bu-legal">
          By continuing you agree to our&nbsp;
          <a href="#" className="bu-link">Terms</a>&nbsp;&amp;&nbsp;
          <a href="#" className="bu-link">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useLocation } from 'wouter';
import { Loader2 } from 'lucide-react';
import { authApi } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

const COUNTRIES = [
  { code: 'RW', flag: '🇷🇼', name: 'Rwanda',        dial: '+250' },
  { code: 'KE', flag: '🇰🇪', name: 'Kenya',         dial: '+254' },
  { code: 'TZ', flag: '🇹🇿', name: 'Tanzania',      dial: '+255' },
  { code: 'UG', flag: '🇺🇬', name: 'Uganda',        dial: '+256' },
  { code: 'NG', flag: '🇳🇬', name: 'Nigeria',       dial: '+234' },
  { code: 'GH', flag: '🇬🇭', name: 'Ghana',         dial: '+233' },
  { code: 'CM', flag: '🇨🇲', name: 'Cameroon',      dial: '+237' },
  { code: 'SN', flag: '🇸🇳', name: 'Senegal',       dial: '+221' },
  { code: 'ZA', flag: '🇿🇦', name: 'South Africa',  dial: '+27'  },
  { code: 'CA', flag: '🇨🇦', name: 'Canada',        dial: '+1'   },
  { code: 'US', flag: '🇺🇸', name: 'United States', dial: '+1'   },
  { code: 'GB', flag: '🇬🇧', name: 'UK',            dial: '+44'  },
  { code: 'FR', flag: '🇫🇷', name: 'France',        dial: '+33'  },
  { code: 'DE', flag: '🇩🇪', name: 'Germany',       dial: '+49'  },
  { code: 'AU', flag: '🇦🇺', name: 'Australia',     dial: '+61'  },
  { code: 'IN', flag: '🇮🇳', name: 'India',         dial: '+91'  },
];

export default function AuthPhone() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [dialCode, setDialCode] = useState('+250');
  const [number, setNumber] = useState('');
  const [loading, setLoading] = useState(false);

  const selected = COUNTRIES.find(c => c.dial === dialCode) ?? COUNTRIES[0];
  const digits = number.replace(/\D/g, '');
  const phone = dialCode + digits;
  const ready = digits.length >= 6;

  async function handleSend() {
    if (!ready || loading) return;
    setLoading(true);
    try {
      await authApi.sendOtp(phone);
      sessionStorage.setItem('bridgeup_verify_phone', phone);
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

  return (
    <div className="bu-auth-root">
      {/* Dark hero */}
      <div className="bu-hero">
        <div className="bu-logo-wrap">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <h1 className="bu-title">BridgeUp</h1>
        <p className="bu-subtitle">Get help instantly — food, shelter,<br />jobs, medical care, and more.</p>

        <div className="bu-stats">
          {[
            { n: '2,400+', l: 'Helped' },
            { n: '12',     l: 'Cities'  },
            { n: '800+',   l: 'Helpers' },
          ].map(s => (
            <div key={s.l} className="bu-stat">
              <span className="bu-stat-n">{s.n}</span>
              <span className="bu-stat-l">{s.l}</span>
            </div>
          ))}
        </div>
      </div>

      {/* White form card */}
      <div className="bu-card">
        <h2 className="bu-card-title">Enter your number</h2>
        <p className="bu-card-sub">We'll send you a 6-digit verification code</p>

        <div className="bu-input-row">
          {/* Country code — native select overlaid on styled display */}
          <div className="bu-cc-wrap">
            <div className="bu-cc-display">
              <span className="bu-cc-flag">{selected.flag}</span>
              <span className="bu-cc-code">{dialCode}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="3"><path d="M6 9l6 6 6-6"/></svg>
            </div>
            <select
              className="bu-cc-select"
              value={dialCode}
              onChange={e => setDialCode(e.target.value)}
              aria-label="Country code"
            >
              {COUNTRIES.map(c => (
                <option key={c.code + c.dial} value={c.dial}>
                  {c.flag}  {c.name}  ({c.dial})
                </option>
              ))}
            </select>
          </div>

          <input
            type="tel"
            inputMode="numeric"
            placeholder="Phone number"
            value={number}
            onChange={e => setNumber(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            className="bu-phone-input"
            autoFocus
            autoComplete="tel-local"
          />
        </div>

        <button
          className={`bu-btn${ready ? ' bu-btn-active' : ''}`}
          onClick={handleSend}
          disabled={!ready || loading}
        >
          {loading
            ? <><Loader2 className="bu-spin" /> Sending…</>
            : <>Continue <span className="bu-arrow">→</span></>}
        </button>

        <p className="bu-legal">
          By continuing you agree to our Terms &amp; Privacy Policy.
          Standard SMS rates may apply.
        </p>
      </div>
    </div>
  );
}

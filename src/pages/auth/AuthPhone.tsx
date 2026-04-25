import { useState } from 'react';
import { useLocation } from 'wouter';
import { Loader2 } from 'lucide-react';
import { authApi } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

const COUNTRIES = [
  // Africa — primary market
  { code: 'RW', flag: '🇷🇼', name: 'Rwanda',           dial: '+250' },
  { code: 'KE', flag: '🇰🇪', name: 'Kenya',            dial: '+254' },
  { code: 'UG', flag: '🇺🇬', name: 'Uganda',           dial: '+256' },
  { code: 'TZ', flag: '🇹🇿', name: 'Tanzania',         dial: '+255' },
  { code: 'NG', flag: '🇳🇬', name: 'Nigeria',          dial: '+234' },
  { code: 'GH', flag: '🇬🇭', name: 'Ghana',            dial: '+233' },
  { code: 'ZA', flag: '🇿🇦', name: 'South Africa',     dial: '+27'  },
  { code: 'ET', flag: '🇪🇹', name: 'Ethiopia',         dial: '+251' },
  { code: 'CM', flag: '🇨🇲', name: 'Cameroon',         dial: '+237' },
  { code: 'SN', flag: '🇸🇳', name: 'Senegal',          dial: '+221' },
  { code: 'CI', flag: '🇨🇮', name: "Côte d'Ivoire",    dial: '+225' },
  { code: 'TG', flag: '🇹🇬', name: 'Togo',             dial: '+228' },
  { code: 'BF', flag: '🇧🇫', name: 'Burkina Faso',     dial: '+226' },
  { code: 'ML', flag: '🇲🇱', name: 'Mali',             dial: '+223' },
  { code: 'NE', flag: '🇳🇪', name: 'Niger',            dial: '+227' },
  { code: 'TD', flag: '🇹🇩', name: 'Chad',             dial: '+235' },
  { code: 'CD', flag: '🇨🇩', name: 'DR Congo',         dial: '+243' },
  { code: 'MZ', flag: '🇲🇿', name: 'Mozambique',       dial: '+258' },
  { code: 'ZM', flag: '🇿🇲', name: 'Zambia',           dial: '+260' },
  { code: 'ZW', flag: '🇿🇼', name: 'Zimbabwe',         dial: '+263' },
  { code: 'BW', flag: '🇧🇼', name: 'Botswana',         dial: '+267' },
  { code: 'MU', flag: '🇲🇺', name: 'Mauritius',        dial: '+230' },
  { code: 'MA', flag: '🇲🇦', name: 'Morocco',          dial: '+212' },
  { code: 'DZ', flag: '🇩🇿', name: 'Algeria',          dial: '+213' },
  { code: 'TN', flag: '🇹🇳', name: 'Tunisia',          dial: '+216' },
  { code: 'EG', flag: '🇪🇬', name: 'Egypt',            dial: '+20'  },
  { code: 'SO', flag: '🇸🇴', name: 'Somalia',          dial: '+252' },
  { code: 'SS', flag: '🇸🇸', name: 'South Sudan',      dial: '+211' },
  // North America
  { code: 'CA', flag: '🇨🇦', name: 'Canada',           dial: '+1'   },
  { code: 'US', flag: '🇺🇸', name: 'United States',    dial: '+1'   },
  { code: 'MX', flag: '🇲🇽', name: 'Mexico',           dial: '+52'  },
  // Europe
  { code: 'GB', flag: '🇬🇧', name: 'United Kingdom',   dial: '+44'  },
  { code: 'FR', flag: '🇫🇷', name: 'France',           dial: '+33'  },
  { code: 'DE', flag: '🇩🇪', name: 'Germany',          dial: '+49'  },
  { code: 'BE', flag: '🇧🇪', name: 'Belgium',          dial: '+32'  },
  { code: 'NL', flag: '🇳🇱', name: 'Netherlands',      dial: '+31'  },
  { code: 'CH', flag: '🇨🇭', name: 'Switzerland',      dial: '+41'  },
  { code: 'IT', flag: '🇮🇹', name: 'Italy',            dial: '+39'  },
  { code: 'ES', flag: '🇪🇸', name: 'Spain',            dial: '+34'  },
  { code: 'PT', flag: '🇵🇹', name: 'Portugal',         dial: '+351' },
  // Asia & Oceania
  { code: 'IN', flag: '🇮🇳', name: 'India',            dial: '+91'  },
  { code: 'AU', flag: '🇦🇺', name: 'Australia',        dial: '+61'  },
  { code: 'CN', flag: '🇨🇳', name: 'China',            dial: '+86'  },
  { code: 'JP', flag: '🇯🇵', name: 'Japan',            dial: '+81'  },
  { code: 'AE', flag: '🇦🇪', name: 'UAE',              dial: '+971' },
  { code: 'SA', flag: '🇸🇦', name: 'Saudi Arabia',     dial: '+966' },
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
      <div className="bu-hero">
        <div className="bu-logo-wrap">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <h1 className="bu-title">BridgeUp</h1>
        <p className="bu-subtitle">Connect with help in your community —<br />food, shelter, jobs, medical care and more.</p>
        <div className="bu-stats">
          {[{ n: '2,400+', l: 'People helped' }, { n: '12', l: 'Cities' }, { n: '800+', l: 'Helpers' }].map(s => (
            <div key={s.l} className="bu-stat">
              <span className="bu-stat-n">{s.n}</span>
              <span className="bu-stat-l">{s.l}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bu-card">
        <h2 className="bu-card-title">Enter your number</h2>
        <p className="bu-card-sub">We'll send a 6-digit verification code via SMS</p>

        <div className="bu-input-row">
          <div className="bu-cc-wrap">
            <div className="bu-cc-display" aria-hidden="true">
              <span className="bu-cc-flag">{selected.flag}</span>
              <span className="bu-cc-code">{dialCode}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
            </div>
            <select
              className="bu-cc-select"
              value={dialCode}
              onChange={e => setDialCode(e.target.value)}
              aria-label="Select country code"
            >
              {COUNTRIES.map(c => (
                <option key={c.code} value={c.dial}>
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
            onChange={e => setNumber(e.target.value.replace(/[^\d\s\-]/g, ''))}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            className="bu-phone-input"
            autoFocus
            autoComplete="tel-local"
            name="phone"
          />
        </div>

        <p className="bu-hint">
          Example: {dialCode === '+1' ? '416 555 0100' : dialCode === '+250' ? '788 123 456' : '7XX XXX XXX'}
        </p>

        <button
          className={`bu-btn${ready ? ' bu-btn-active' : ''}`}
          onClick={handleSend}
          disabled={!ready || loading}
        >
          {loading
            ? <><Loader2 className="bu-spin" />&nbsp;Sending code…</>
            : <>Continue &nbsp;→</>}
        </button>

        <p className="bu-legal">
          By continuing you agree to our&nbsp;
          <a href="#" className="bu-link">Terms</a>
          &nbsp;&amp;&nbsp;
          <a href="#" className="bu-link">Privacy Policy</a>.
          Standard SMS rates may apply.
        </p>
      </div>
    </div>
  );
}

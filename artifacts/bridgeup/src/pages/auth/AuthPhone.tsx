import { useState, useRef } from 'react';
import { useLocation } from 'wouter';
import { Phone, Globe, ChevronDown, ArrowRight, Loader2 } from 'lucide-react';
import { authApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

const COUNTRIES = [
  { code: 'RW', flag: '🇷🇼', name: 'Rwanda',       dial: '+250' },
  { code: 'KE', flag: '🇰🇪', name: 'Kenya',        dial: '+254' },
  { code: 'TZ', flag: '🇹🇿', name: 'Tanzania',     dial: '+255' },
  { code: 'UG', flag: '🇺🇬', name: 'Uganda',       dial: '+256' },
  { code: 'NG', flag: '🇳🇬', name: 'Nigeria',      dial: '+234' },
  { code: 'GH', flag: '🇬🇭', name: 'Ghana',        dial: '+233' },
  { code: 'CA', flag: '🇨🇦', name: 'Canada',       dial: '+1'   },
  { code: 'US', flag: '🇺🇸', name: 'United States',dial: '+1'   },
  { code: 'GB', flag: '🇬🇧', name: 'UK',           dial: '+44'  },
  { code: 'FR', flag: '🇫🇷', name: 'France',       dial: '+33'  },
];

export default function AuthPhone() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [number, setNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [showCountries, setShowCountries] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const phone = country.dial + number.replace(/\D/g, '');

  async function handleSend() {
    if (!number.trim()) {
      toast({ title: 'Enter your phone number', variant: 'destructive' });
      inputRef.current?.focus();
      return;
    }
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
    <div className="min-h-screen flex flex-col bg-background">
      {/* Hero section */}
      <div className="flex-1 flex flex-col">
        <div className="relative overflow-hidden bg-gradient-to-br from-primary/90 to-primary px-6 pt-16 pb-24">
          <div className="absolute inset-0 opacity-10">
            <div className="absolute top-8 right-8 w-40 h-40 rounded-full bg-white" />
            <div className="absolute -bottom-10 -left-10 w-64 h-64 rounded-full bg-white" />
          </div>
          <div className="relative">
            <div className="w-14 h-14 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center mb-6 border border-white/30">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h1 className="text-4xl font-bold text-white tracking-tight mb-2">BridgeUp</h1>
            <p className="text-white/80 text-lg leading-relaxed max-w-xs">
              Connect with help in your community — instantly, safely, anywhere.
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 divide-x divide-border -mt-6 mx-6 bg-card rounded-2xl shadow-lg border border-border overflow-hidden">
          {[
            { label: 'People helped', value: '2,400+' },
            { label: 'Cities', value: '12' },
            { label: 'Helpers', value: '800+' },
          ].map((s) => (
            <div key={s.label} className="flex flex-col items-center py-4 px-2">
              <span className="text-xl font-bold text-foreground">{s.value}</span>
              <span className="text-xs text-muted-foreground text-center mt-0.5">{s.label}</span>
            </div>
          ))}
        </div>

        {/* Form */}
        <div className="px-6 pt-8 pb-6 flex-1 flex flex-col justify-end gap-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <Phone className="w-4 h-4" />
              Enter your phone number to get started
            </p>

            <div className="flex gap-3">
              {/* Country selector */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowCountries(!showCountries)}
                  className="flex items-center gap-1.5 px-3 py-4 rounded-xl border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
                >
                  <span className="text-base">{country.flag}</span>
                  <span className="text-muted-foreground">{country.dial}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                </button>

                {showCountries && (
                  <div className="absolute top-full left-0 z-50 mt-1 w-56 bg-card border border-border rounded-xl shadow-xl overflow-hidden">
                    {COUNTRIES.map((c) => (
                      <button
                        key={c.code + c.dial}
                        type="button"
                        onClick={() => { setCountry(c); setShowCountries(false); }}
                        className="w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted transition-colors text-left"
                      >
                        <span className="text-base">{c.flag}</span>
                        <span className="flex-1 text-foreground">{c.name}</span>
                        <span className="text-muted-foreground">{c.dial}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Phone input */}
              <input
                ref={inputRef}
                type="tel"
                inputMode="numeric"
                placeholder="Phone number"
                value={number}
                onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                className="flex-1 px-4 py-4 rounded-xl border border-border bg-card text-base focus:outline-none focus:ring-2 focus:ring-primary/50 transition"
              />
            </div>
          </div>

          <Button
            size="lg"
            className="w-full h-14 text-base font-semibold rounded-xl"
            onClick={handleSend}
            disabled={loading || !number.trim()}
          >
            {loading ? (
              <><Loader2 className="w-5 h-5 animate-spin mr-2" />Sending code...</>
            ) : (
              <>Continue <ArrowRight className="w-5 h-5 ml-2" /></>
            )}
          </Button>

          <p className="text-xs text-center text-muted-foreground leading-relaxed">
            By continuing, you agree to our Terms and Privacy Policy.
            We&apos;ll send a verification code to this number.
          </p>

          <div className="flex items-center gap-2 justify-center text-xs text-muted-foreground pt-2">
            <Globe className="w-3.5 h-3.5" />
            <span>Available in Canada, Rwanda, Kenya and 10+ countries</span>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useLocation } from 'wouter';
import {
  ChevronLeft, ChevronRight, MapPin, Loader2,
  UtensilsCrossed, Home, Briefcase, Heart,
  GraduationCap, Banknote, HelpCircle, Sparkles,
} from 'lucide-react';
import { needsApi } from '@/lib/api';
import type { NeedCategory } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { AppShell } from '@/components/layout/AppShell';

const CATEGORIES: { key: NeedCategory; icon: React.ComponentType<{ className?: string }>; label: string; desc: string; color: string }[] = [
  { key: 'food',       icon: UtensilsCrossed, label: 'Food & Water',  desc: 'Meals, groceries, nutrition',      color: 'from-orange-400 to-amber-500'  },
  { key: 'housing',    icon: Home,            label: 'Housing',       desc: 'Shelter, rent, emergency stay',    color: 'from-blue-400 to-cyan-500'     },
  { key: 'employment', icon: Briefcase,       label: 'Employment',    desc: 'Jobs, skills, income',             color: 'from-violet-400 to-purple-500' },
  { key: 'medical',    icon: Heart,           label: 'Medical',       desc: 'Healthcare, medicine, support',    color: 'from-red-400 to-rose-500'      },
  { key: 'training',   icon: GraduationCap,   label: 'Training',      desc: 'Education, courses, mentorship',   color: 'from-teal-400 to-emerald-500'  },
  { key: 'funding',    icon: Banknote,        label: 'Financial Aid', desc: 'Grants, donations, microloans',    color: 'from-green-400 to-lime-500'    },
  { key: 'other',      icon: HelpCircle,      label: 'Other',         desc: 'Any other support needed',         color: 'from-gray-400 to-slate-500'    },
];

const URGENCY_OPTIONS = [
  { key: 'immediate', label: 'Right now',      sub: 'I need help within hours',    dot: 'bg-red-500',    border: 'border-red-200',    bg: 'bg-red-50'    },
  { key: 'days',      label: 'In a few days',  sub: 'Within the next 3-5 days',    dot: 'bg-amber-500',  border: 'border-amber-200',  bg: 'bg-amber-50'  },
  { key: 'weeks',     label: 'Within weeks',   sub: 'I have some flexibility',     dot: 'bg-green-500',  border: 'border-green-200',  bg: 'bg-green-50'  },
];

type Step = 'category' | 'details' | 'urgency' | 'review';

export default function PostNeed() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>('category');
  const [category, setCategory] = useState<NeedCategory | null>(null);
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [locationLat, setLocationLat] = useState<number | null>(null);
  const [locationLng, setLocationLng] = useState<number | null>(null);
  const [urgency, setUrgency] = useState<'immediate' | 'days' | 'weeks'>('days');
  const [loading, setLoading] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);

  const STEPS: Step[] = ['category', 'details', 'urgency', 'review'];
  const stepIdx = STEPS.indexOf(step);
  const progress = ((stepIdx + 1) / STEPS.length) * 100;

  function detectLocation() {
    setGeoLoading(true);
    navigator.geolocation?.getCurrentPosition(
      async (pos) => {
        setLocationLat(pos.coords.latitude);
        setLocationLng(pos.coords.longitude);
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json`);
          const d = await r.json();
          setLocation(d.display_name?.split(',').slice(0, 3).join(',') || 'Current location');
        } catch {
          setLocation('Current location');
        }
        setGeoLoading(false);
      },
      () => {
        toast({ title: 'Location access denied', description: 'Please type your location manually.', variant: 'destructive' });
        setGeoLoading(false);
      }
    );
  }

  async function submit() {
    if (!category) return;
    setLoading(true);
    try {
      const { needId } = await needsApi.create({
        category,
        description,
        location: location || undefined,
        locationLat: locationLat ?? undefined,
        locationLng: locationLng ?? undefined,
        urgency,
      });
      toast({ title: 'Request submitted!', description: "We're finding helpers near you." });
      navigate(`/needs/${needId}`);
    } catch (err: unknown) {
      toast({ title: 'Could not submit', description: err instanceof Error ? err.message : 'Please try again.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  function back() {
    if (step === 'category') navigate('/home');
    else setStep(STEPS[stepIdx - 1]);
  }

  const canAdvance = {
    category: !!category,
    details: description.trim().length >= 10,
    urgency: !!urgency,
    review: true,
  }[step];

  return (
    <AppShell hideNav>
      <div className="flex flex-col h-full overflow-x-hidden" style={{ background: '#f4f4f6' }}>
        <div className="bu-page flex flex-col flex-1 overflow-hidden">

          {/* Header */}
          <div className="flex items-center px-5 pt-12 pb-4 gap-3 flex-shrink-0">
            <button
              type="button"
              onClick={back}
              className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted transition-colors flex-shrink-0"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="flex-1">
              <h1 className="font-bold text-[17px] text-gray-900">Get Help</h1>
              <div className="flex items-center gap-2 mt-1.5">
                <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="text-xs text-gray-400">{stepIdx + 1} of {STEPS.length}</span>
              </div>
            </div>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-5 pb-4" style={{ background: '#f4f4f6' }}>

            {/* Step: Category */}
            {step === 'category' && (
              <div>
                <h2 className="text-2xl font-bold mb-1 text-gray-900">What do you need?</h2>
                <p className="text-gray-500 text-[14px] mb-6">Select the type of help you're looking for</p>
                <div className="grid grid-cols-2 gap-3">
                  {CATEGORIES.map(({ key, icon: Icon, label, desc, color }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => { setCategory(key); setStep('details'); }}
                      className={`flex flex-col p-4 rounded-2xl border-2 text-left transition-all active:scale-95 ${category === key ? 'border-primary shadow-md bg-primary/3' : 'border-gray-100 hover:border-primary/40 hover:shadow-sm bg-white'}`}
                      style={{ boxShadow: category === key ? undefined : '0 1px 4px rgba(0,0,0,0.06)' }}
                    >
                      <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${color} flex items-center justify-center mb-3`}>
                        <Icon className="w-5 h-5 text-white" />
                      </div>
                      <span className="font-semibold text-[13px] text-gray-900">{label}</span>
                      <span className="text-[11px] text-gray-400 mt-0.5 leading-snug">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Step: Details */}
            {step === 'details' && (
              <div>
                <h2 className="text-2xl font-bold mb-1 text-gray-900">Tell us more</h2>
                <p className="text-gray-500 text-[14px] mb-6">The more detail you share, the better we can match you</p>
                <div className="space-y-4">
                  <div>
                    <label className="text-[13px] font-semibold text-gray-700 mb-2 block">Describe what you need</label>
                    <textarea
                      rows={4}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="e.g. I need help getting food for my family of 4. We have no groceries and no income right now…"
                      className="w-full p-4 rounded-2xl border border-gray-200 bg-white resize-none focus:outline-none focus:ring-2 focus:ring-primary/40 text-[14px] leading-relaxed"
                      style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}
                      maxLength={2000}
                    />
                    <div className="flex justify-between mt-1.5">
                      <span className={`text-[11px] ${description.length < 10 ? 'text-red-500' : 'text-transparent'}`}>
                        {10 - description.length} more characters needed
                      </span>
                      <span className="text-[11px] text-gray-400">{description.length}/2000</span>
                    </div>
                  </div>

                  <div>
                    <label className="text-[13px] font-semibold text-gray-700 mb-2 block">Your location</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                        placeholder="City, neighbourhood, or address"
                        className="flex-1 px-4 py-3 rounded-2xl border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-primary/40 text-[14px]"
                        style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}
                      />
                      <button
                        type="button"
                        onClick={detectLocation}
                        disabled={geoLoading}
                        className="w-12 h-12 rounded-2xl border border-gray-200 bg-white hover:bg-gray-50 transition-colors flex items-center justify-center flex-shrink-0"
                        style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}
                      >
                        {geoLoading ? (
                          <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        ) : (
                          <MapPin className="w-4 h-4 text-primary" />
                        )}
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => navigate('/intake')}
                    className="w-full flex items-center gap-3 p-4 bg-blue-50 rounded-2xl border border-blue-100 text-left"
                  >
                    <Sparkles className="w-4 h-4 text-primary flex-shrink-0" />
                    <p className="text-[13px] text-gray-600">
                      Want to describe your need through a conversation?{' '}
                      <span className="text-primary font-semibold">Try AI intake →</span>
                    </p>
                  </button>
                </div>
              </div>
            )}

            {/* Step: Urgency */}
            {step === 'urgency' && (
              <div>
                <h2 className="text-2xl font-bold mb-1 text-gray-900">How urgent is this?</h2>
                <p className="text-gray-500 text-[14px] mb-6">This helps us prioritise matching</p>
                <div className="space-y-3">
                  {URGENCY_OPTIONS.map(({ key, label, sub, dot, border, bg }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setUrgency(key as typeof urgency)}
                      className={`w-full flex items-center gap-4 p-4 rounded-2xl border-2 text-left transition-all ${urgency === key ? `${border} ${bg}` : 'border-gray-100 hover:border-gray-200 bg-white'}`}
                      style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}
                    >
                      <div className={`w-4 h-4 rounded-full ${dot} flex-shrink-0`} />
                      <div className="flex-1">
                        <p className="font-semibold text-[14px] text-gray-900">{label}</p>
                        <p className="text-[12px] text-gray-500 mt-0.5">{sub}</p>
                      </div>
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${urgency === key ? 'border-primary' : 'border-gray-200'}`}>
                        {urgency === key && <div className="w-2.5 h-2.5 rounded-full bg-primary" />}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Step: Review */}
            {step === 'review' && (
              <div>
                <h2 className="text-2xl font-bold mb-1 text-gray-900">Review your request</h2>
                <p className="text-gray-500 text-[14px] mb-6">Make sure everything looks right before submitting</p>
                <div className="rounded-2xl border border-gray-100 overflow-hidden" style={{ boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}>
                  {[
                    { label: 'Type of help', value: CATEGORIES.find((c) => c.key === category)?.label },
                    { label: 'Description',  value: description },
                    { label: 'Location',     value: location || 'Not specified' },
                    { label: 'Urgency',      value: URGENCY_OPTIONS.find((u) => u.key === urgency)?.label },
                  ].map(({ label, value }, i, arr) => (
                    <div key={label} className={`flex gap-4 p-4 bg-white ${i < arr.length - 1 ? 'border-b border-gray-100' : ''}`}>
                      <span className="text-[12px] font-semibold text-gray-400 uppercase tracking-wide w-24 flex-shrink-0 pt-0.5">{label}</span>
                      <span className="text-[14px] text-gray-900 flex-1 leading-snug">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* CTA button */}
          {step !== 'category' && (
            <div className="px-5 pb-8 pt-3 border-t border-gray-100 flex-shrink-0">
              <button
                type="button"
                className="w-full h-14 rounded-2xl text-[15px] font-bold text-white transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: canAdvance && !loading ? '#000000' : '#d1d5db', cursor: canAdvance && !loading ? 'pointer' : 'not-allowed' }}
                onClick={step === 'review' ? submit : () => setStep(STEPS[stepIdx + 1])}
                disabled={!canAdvance || loading}
              >
                {loading ? (
                  <><Loader2 className="w-5 h-5 animate-spin" />Submitting…</>
                ) : step === 'review' ? (
                  'Submit Request'
                ) : (
                  <>Continue <ChevronRight className="w-5 h-5" /></>
                )}
              </button>
            </div>
          )}

        </div>
      </div>
    </AppShell>
  );
}

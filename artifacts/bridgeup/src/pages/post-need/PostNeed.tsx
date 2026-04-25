import { useState } from 'react';
import { useLocation } from 'wouter';
import {
  ChevronLeft, ChevronRight, MapPin, Loader2,
  UtensilsCrossed, Home, Briefcase, Heart,
  GraduationCap, Banknote, HelpCircle, Sparkles,
} from 'lucide-react';
import { needsApi } from '@/lib/api';
import type { NeedCategory } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { AppShell } from '@/components/layout/AppShell';

const CATEGORIES: { key: NeedCategory; icon: React.ComponentType<{ className?: string }>; label: string; desc: string; color: string }[] = [
  { key: 'food',       icon: UtensilsCrossed, label: 'Food & Water',    desc: 'Meals, groceries, nutrition',        color: 'from-orange-400 to-amber-500'  },
  { key: 'housing',    icon: Home,            label: 'Housing',         desc: 'Shelter, rent, emergency stay',      color: 'from-blue-400 to-cyan-500'     },
  { key: 'employment', icon: Briefcase,       label: 'Employment',      desc: 'Jobs, skills, income',               color: 'from-violet-400 to-purple-500' },
  { key: 'medical',    icon: Heart,           label: 'Medical',         desc: 'Healthcare, medicine, support',      color: 'from-red-400 to-rose-500'      },
  { key: 'training',   icon: GraduationCap,   label: 'Training',        desc: 'Education, courses, mentorship',     color: 'from-teal-400 to-emerald-500'  },
  { key: 'funding',    icon: Banknote,        label: 'Financial Aid',   desc: 'Grants, donations, microloans',      color: 'from-green-400 to-lime-500'    },
  { key: 'other',      icon: HelpCircle,      label: 'Other',           desc: 'Any other support needed',           color: 'from-gray-400 to-slate-500'    },
];

const URGENCY_OPTIONS = [
  { key: 'immediate', label: 'Right now',   sub: 'I need help within hours', dot: 'bg-red-500',   border: 'border-red-300',   bg: 'bg-red-50'   },
  { key: 'days',      label: 'In a few days', sub: 'Within the next 3-5 days', dot: 'bg-amber-500', border: 'border-amber-300', bg: 'bg-amber-50' },
  { key: 'weeks',     label: 'Within weeks', sub: 'I have some flexibility',  dot: 'bg-green-500', border: 'border-green-300', bg: 'bg-green-50' },
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
      <div className="flex flex-col h-full bg-background">
        {/* Header */}
        <div className="flex items-center px-4 pt-12 pb-4 gap-3">
          <button
            type="button"
            onClick={back}
            className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="font-bold text-lg">Get Help</h1>
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground">{stepIdx + 1} of {STEPS.length}</span>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {/* Step: Category */}
          {step === 'category' && (
            <div>
              <h2 className="text-2xl font-bold mb-1">What do you need?</h2>
              <p className="text-muted-foreground mb-6">Select the type of help you&apos;re looking for</p>
              <div className="grid grid-cols-2 gap-3">
                {CATEGORIES.map(({ key, icon: Icon, label, desc, color }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => { setCategory(key); setStep('details'); }}
                    className={`flex flex-col p-4 rounded-2xl border-2 text-left transition-all active:scale-95 ${category === key ? 'border-primary shadow-md' : 'border-border hover:border-primary/50 hover:shadow-sm'}`}
                  >
                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${color} flex items-center justify-center mb-3`}>
                      <Icon className="w-5 h-5 text-white" />
                    </div>
                    <span className="font-semibold text-sm">{label}</span>
                    <span className="text-xs text-muted-foreground mt-0.5">{desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step: Details */}
          {step === 'details' && (
            <div>
              <h2 className="text-2xl font-bold mb-1">Tell us more</h2>
              <p className="text-muted-foreground mb-6">The more detail you share, the better we can match you</p>

              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">Describe what you need</label>
                  <textarea
                    rows={4}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g. I need help getting food for my family of 4. We have no groceries and no income right now…"
                    className="w-full p-3 rounded-xl border border-border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                    maxLength={2000}
                  />
                  <div className="flex justify-between mt-1">
                    <span className={`text-xs ${description.length < 10 ? 'text-red-500' : 'text-muted-foreground'}`}>
                      {description.length < 10 ? `${10 - description.length} more characters needed` : ''}
                    </span>
                    <span className="text-xs text-muted-foreground">{description.length}/2000</span>
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">Your location</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="City, neighbourhood, or address"
                      className="flex-1 px-3 py-3 rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                    />
                    <button
                      type="button"
                      onClick={detectLocation}
                      disabled={geoLoading}
                      className="px-3 py-3 rounded-xl border border-border bg-card hover:bg-muted transition-colors"
                    >
                      {geoLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <MapPin className="w-4 h-4 text-primary" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 p-3 bg-primary/5 rounded-xl border border-primary/20">
                  <Sparkles className="w-4 h-4 text-primary flex-shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    Want to describe your need through a conversation?{' '}
                    <button type="button" onClick={() => navigate('/intake')} className="text-primary font-medium">Try AI intake</button>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Step: Urgency */}
          {step === 'urgency' && (
            <div>
              <h2 className="text-2xl font-bold mb-1">How urgent is this?</h2>
              <p className="text-muted-foreground mb-6">This helps us prioritise matching</p>
              <div className="space-y-3">
                {URGENCY_OPTIONS.map(({ key, label, sub, dot, border, bg }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setUrgency(key as typeof urgency)}
                    className={`w-full flex items-center gap-4 p-4 rounded-2xl border-2 text-left transition-all ${urgency === key ? `${border} ${bg}` : 'border-border hover:border-primary/40'}`}
                  >
                    <div className={`w-4 h-4 rounded-full ${dot} flex-shrink-0`} />
                    <div>
                      <p className="font-semibold">{label}</p>
                      <p className="text-sm text-muted-foreground">{sub}</p>
                    </div>
                    {urgency === key && (
                      <div className="ml-auto w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                        <div className="w-2 h-2 rounded-full bg-white" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step: Review */}
          {step === 'review' && (
            <div>
              <h2 className="text-2xl font-bold mb-1">Review your request</h2>
              <p className="text-muted-foreground mb-6">Make sure everything looks right before submitting</p>
              <div className="space-y-3">
                {[
                  { label: 'Type of help', value: CATEGORIES.find((c) => c.key === category)?.label },
                  { label: 'Description',  value: description },
                  { label: 'Location',     value: location || 'Not specified' },
                  { label: 'Urgency',      value: URGENCY_OPTIONS.find((u) => u.key === urgency)?.label },
                ].map(({ label, value }) => (
                  <div key={label} className="flex gap-3 p-4 bg-muted/50 rounded-xl">
                    <span className="text-sm text-muted-foreground w-24 flex-shrink-0">{label}</span>
                    <span className="text-sm font-medium flex-1">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* CTA */}
        {step !== 'category' && (
          <div className="px-4 pb-8 pt-3 border-t border-border">
            <Button
              size="lg"
              className="w-full h-14 text-base font-semibold rounded-xl"
              onClick={step === 'review' ? submit : () => setStep(STEPS[stepIdx + 1])}
              disabled={!canAdvance || loading}
            >
              {loading ? (
                <><Loader2 className="w-5 h-5 animate-spin mr-2" />Submitting…</>
              ) : step === 'review' ? (
                'Submit Request'
              ) : (
                <>Continue <ChevronRight className="w-5 h-5 ml-1" /></>
              )}
            </Button>
          </div>
        )}
      </div>
    </AppShell>
  );
}

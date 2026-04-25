import { useLocation } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, CheckCircle, XCircle, Star, MapPin, Loader, Navigation, Phone, MessageCircle, Car } from 'lucide-react';
import { matchesApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { AppShell } from '@/components/layout/AppShell';
import { useAuthStore } from '@/store/auth';

export default function MatchDetail() {
  const [location, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuthStore();
  const qc = useQueryClient();
  const id = location.split('/').pop()!;

  const { data, isLoading } = useQuery({
    queryKey: ['match', id],
    queryFn:  () => matchesApi.get(id),
    refetchInterval: 10_000,
  });

  const acceptMutation = useMutation({
    mutationFn: () => matchesApi.accept(id),
    onSuccess: () => {
      toast({ title: 'Match accepted!', description: 'The person in need has been notified.' });
      qc.invalidateQueries({ queryKey: ['match', id] });
      qc.invalidateQueries({ queryKey: ['matches'] });
    },
    onError: (err: Error) => toast({ title: 'Could not accept', description: err.message, variant: 'destructive' }),
  });

  const declineMutation = useMutation({
    mutationFn: () => matchesApi.decline(id),
    onSuccess: () => {
      toast({ title: 'Match declined', description: 'We will look for another helper.' });
      navigate('/matches');
    },
    onError: (err: Error) => toast({ title: 'Could not decline', description: err.message, variant: 'destructive' }),
  });

  const match = data?.match;
  const isHelper = user?.role === 'helper';
  const isPending = match?.status === 'pending';

  // ── Deep links (no API key needed) ───────────────────────────────────────
  const helperLat = match?.helper?.locationLat;
  const helperLng = match?.helper?.locationLng;
  const helperName = encodeURIComponent(match?.helper?.organization || match?.helper?.user?.displayName || 'Helper');
  const helperPhone = match?.helper?.user?.phone?.replace(/\D/g, '');
  const needLocation = match?.need?.location;

  const googleMapsUrl = helperLat
    ? `https://maps.google.com/maps?daddr=${helperLat},${helperLng}&travelmode=driving`
    : needLocation
    ? `https://maps.google.com/maps?q=${encodeURIComponent(needLocation)}`
    : null;

  const uberUrl = helperLat
    ? `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=${helperLat}&dropoff[longitude]=${helperLng}&dropoff[nickname]=${helperName}`
    : null;

  const whatsappUrl = helperPhone ? `https://wa.me/${helperPhone}` : null;
  const callUrl     = helperPhone ? `tel:+${helperPhone}` : null;

  return (
    <AppShell hideNav>
      <div className="flex flex-col h-full bg-background overflow-y-auto">
        <div className="bu-page">
        <div className="flex items-center gap-3 px-5 pt-12 pb-4">
          <button type="button" onClick={() => navigate('/matches')} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-bold flex-1">Match Details</h1>
          {match && (
            <span className={`text-xs font-medium px-3 py-1.5 rounded-full ${
              match.status === 'accepted' || match.status === 'in_progress' ? 'bg-green-100 text-green-700' :
              match.status === 'resolved' ? 'bg-gray-100 text-gray-600' :
              match.status === 'pending'  ? 'bg-amber-100 text-amber-700' :
              'bg-red-100 text-red-700'
            }`}>
              {match.status.charAt(0).toUpperCase() + match.status.slice(1).replace('_', ' ')}
            </span>
          )}
        </div>

        {isLoading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {!isLoading && match && (
          <div className="px-5 pb-8 space-y-4">
            {/* Uber-style status hero */}
            <div className="relative overflow-hidden bg-gradient-to-br from-primary/10 to-primary/5 rounded-3xl p-6 border border-primary/20">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center">
                  {match.status === 'accepted' || match.status === 'in_progress' ? (
                    <Navigation className="w-8 h-8 text-primary" />
                  ) : match.status === 'resolved' ? (
                    <CheckCircle className="w-8 h-8 text-green-600" />
                  ) : (
                    <Loader className="w-8 h-8 text-primary" />
                  )}
                </div>
                <div>
                  <p className="text-lg font-bold">
                    {match.status === 'pending'    && 'Awaiting helper response'}
                    {match.status === 'accepted'   && 'Helper is on the way!'}
                    {match.status === 'in_progress'&& 'Help in progress'}
                    {match.status === 'resolved'   && 'Need resolved'}
                    {match.status === 'declined'   && 'Match declined'}
                    {match.status === 'cancelled'  && 'Match cancelled'}
                  </p>
                  {match.distanceKm && (
                    <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-0.5">
                      <MapPin className="w-3.5 h-3.5" />
                      {match.distanceKm.toFixed(1)} km away
                    </p>
                  )}
                </div>
              </div>

              {/* Score */}
              {match.score > 0 && (
                <div className="absolute top-4 right-4 flex items-center gap-1">
                  <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                  <span className="text-xs font-medium text-amber-700">{match.score}% match</span>
                </div>
              )}
            </div>

            {/* Need summary */}
            {match.need && (
              <div className="p-4 bg-card rounded-2xl border border-border">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Request</p>
                <p className="font-medium capitalize mb-1">{match.need.category}</p>
                <p className="text-sm text-muted-foreground">{match.need.description}</p>
                {match.need.location && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-2">
                    <MapPin className="w-3 h-3" />{match.need.location}
                  </p>
                )}
              </div>
            )}

            {/* Helper info (for person in need) */}
            {!isHelper && match.helper && (
              <div className="p-4 bg-card rounded-2xl border border-border">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Your Helper</p>
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center text-xl font-bold">
                    {match.helper.user?.displayName?.[0]?.toUpperCase() ?? '?'}
                  </div>
                  <div>
                    <p className="font-semibold">{match.helper.user?.displayName ?? 'Helper'}</p>
                    {match.helper.organization && <p className="text-xs text-muted-foreground">{match.helper.organization}</p>}
                    <div className="flex items-center gap-1 mt-1">
                      <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
                      <span className="text-xs font-medium">{match.helper.rating.toFixed(1)}</span>
                      <span className="text-xs text-muted-foreground">· {match.helper.totalResolved} resolved</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Action buttons: directions, Uber, call, WhatsApp ── */}
            {!isHelper && (googleMapsUrl || uberUrl || callUrl || whatsappUrl) && (
              <div className="grid grid-cols-2 gap-3">
                {googleMapsUrl && (
                  <a
                    href={googleMapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 p-3.5 rounded-2xl text-[13px] font-semibold transition-colors"
                    style={{ background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', textDecoration: 'none' }}
                  >
                    <Navigation style={{ width: 16, height: 16 }} />
                    Get Directions
                  </a>
                )}
                {uberUrl && (
                  <a
                    href={uberUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 p-3.5 rounded-2xl text-[13px] font-semibold transition-colors"
                    style={{ background: '#000000', color: '#ffffff', textDecoration: 'none' }}
                  >
                    <Car style={{ width: 16, height: 16 }} />
                    Book Uber
                  </a>
                )}
                {callUrl && (
                  <a
                    href={callUrl}
                    className="flex items-center justify-center gap-2 p-3.5 rounded-2xl text-[13px] font-semibold"
                    style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', textDecoration: 'none' }}
                  >
                    <Phone style={{ width: 16, height: 16 }} />
                    Call Helper
                  </a>
                )}
                {whatsappUrl && (
                  <a
                    href={whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 p-3.5 rounded-2xl text-[13px] font-semibold"
                    style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', textDecoration: 'none' }}
                  >
                    <MessageCircle style={{ width: 16, height: 16 }} />
                    WhatsApp
                  </a>
                )}
              </div>
            )}

            {/* Helper actions */}
            {isHelper && isPending && (
              <div className="space-y-3">
                <Button
                  className="w-full h-14 text-base rounded-xl"
                  onClick={() => acceptMutation.mutate()}
                  disabled={acceptMutation.isPending}
                >
                  {acceptMutation.isPending ? <Loader className="w-5 h-5 animate-spin" /> : <><CheckCircle className="w-5 h-5 mr-2" />Accept this match</>}
                </Button>
                <Button
                  variant="outline"
                  className="w-full h-12 rounded-xl"
                  onClick={() => declineMutation.mutate()}
                  disabled={declineMutation.isPending}
                >
                  {declineMutation.isPending ? <Loader className="w-5 h-5 animate-spin" /> : <><XCircle className="w-5 h-5 mr-2 text-muted-foreground" />Decline</>}
                </Button>
              </div>
            )}

            {/* Timestamps */}
            <div className="p-4 bg-card rounded-2xl border border-border space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Timeline</p>
              {[
                { label: 'Matched', ts: match.createdAt },
                { label: 'Accepted', ts: match.acceptedAt },
                { label: 'Resolved', ts: match.resolvedAt },
              ].filter((e) => e.ts).map((e) => (
                <div key={e.label} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{e.label}</span>
                  <span className="font-medium">{new Date(e.ts!).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        </div>{/* bu-page */}
      </div>
    </AppShell>
  );
}

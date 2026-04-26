import { useState } from 'react';
import { useLocation } from 'wouter';
import { useMutation } from '@tanstack/react-query';
import {
  ChevronLeft, Edit2, Save, Loader2,
  Shield, Globe, Phone, LogOut, Check,
} from 'lucide-react';
import { authApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useToast } from '@/hooks/use-toast';
import { AppShell } from '@/components/layout/AppShell';

const ROLE_LABELS: Record<string, string> = {
  user:       'Member',
  helper:     'Helper',
  admin:      'Admin',
  ngo:        'NGO',
  superadmin: 'Super Admin',
};

const ROLE_COLORS: Record<string, string> = {
  user:       '#2563eb',
  helper:     '#16a34a',
  admin:      '#7c3aed',
  ngo:        '#0d9488',
  superadmin: '#dc2626',
};

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'rw', label: 'Kinyarwanda' },
  { code: 'sw', label: 'Kiswahili' },
  { code: 'ar', label: 'العربية' },
  { code: 'es', label: 'Español' },
];

export default function Profile() {
  const [, navigate] = useLocation();
  const { user, logout, setUser } = useAuthStore();
  const { toast } = useToast();

  const [editing,     setEditing]     = useState(false);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [bio,         setBio]         = useState(user?.bio ?? '');
  const [language,    setLanguage]    = useState(user?.language ?? 'en');

  const updateMutation = useMutation({
    mutationFn: () => authApi.updateMe({ display_name: displayName, bio, language } as Parameters<typeof authApi.updateMe>[0]),
    onSuccess: ({ user: updated }) => {
      setUser(updated);
      setEditing(false);
      toast({ title: 'Profile updated!' });
    },
    onError: (err: Error) => toast({ title: 'Could not update', description: err.message, variant: 'destructive' }),
  });

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  if (!user) return null;

  const initials = user.displayName
    ? user.displayName.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
    : user.phone.slice(-2);

  const langLabel = LANGUAGES.find((l) => l.code === user.language)?.label ?? user.language;

  return (
    <AppShell>
      <div style={{ minHeight: '100%', background: '#f4f4f6', overflowY: 'auto', fontFamily: 'Inter, system-ui, sans-serif' }}>
        <div className="bu-page" style={{ padding: '0 16px 40px' }}>

          {/* ── Header bar ── */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '48px 0 20px', gap: 8 }}>
            <button
              type="button"
              onClick={() => navigate('/home')}
              style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <ChevronLeft style={{ width: 18, height: 18, color: '#374151' }} />
            </button>
            <h1 style={{ flex: 1, margin: 0, fontSize: 20, fontWeight: 800, color: '#111827', letterSpacing: '-0.3px' }}>
              Account
            </h1>
            <button
              type="button"
              onClick={() => setEditing((e) => !e)}
              style={{
                padding: '7px 14px', borderRadius: 20, border: 'none', cursor: 'pointer',
                background: editing ? '#eff6ff' : '#e5e7eb',
                color: editing ? '#2563eb' : '#374151',
                fontSize: 12, fontWeight: 700,
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              {editing ? <><Check style={{ width: 13, height: 13 }} />Done</> : <><Edit2 style={{ width: 13, height: 13 }} />Edit</>}
            </button>
          </div>

          {/* ── Avatar + name card ── */}
          <div style={{
            background: '#fff', borderRadius: 20, padding: '28px 24px 24px',
            boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: 16,
            display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
          }}>
            {/* Avatar */}
            <div style={{
              width: 80, height: 80, borderRadius: '50%',
              background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 28, fontWeight: 800, color: '#fff',
              marginBottom: 14, boxShadow: '0 4px 20px rgba(37,99,235,0.3)',
            }}>
              {initials}
            </div>

            {/* Name */}
            {editing ? (
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                maxLength={100}
                style={{
                  fontSize: 20, fontWeight: 700, color: '#111827',
                  border: 'none', borderBottom: '2px solid #2563eb',
                  background: 'transparent', outline: 'none', textAlign: 'center',
                  width: '100%', marginBottom: 8, padding: '4px 0',
                  fontFamily: 'inherit',
                }}
              />
            ) : (
              <p style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: '#111827', letterSpacing: '-0.3px' }}>
                {user.displayName || 'Your Name'}
              </p>
            )}

            {/* Role badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 99,
                background: `${ROLE_COLORS[user.role] || '#2563eb'}18`,
                color: ROLE_COLORS[user.role] || '#2563eb',
              }}>
                {ROLE_LABELS[user.role] || 'Member'}
              </span>
              {user.country && (
                <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 500 }}>{user.country}</span>
              )}
            </div>
          </div>

          {/* ── Info card ── */}
          <div style={{ background: '#fff', borderRadius: 20, overflow: 'hidden', boxShadow: '0 2px 16px rgba(0,0,0,0.07)', marginBottom: 16 }}>

            {/* Bio row */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
              <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                About
              </p>
              {editing ? (
                <textarea
                  rows={3}
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="Tell the community about yourself…"
                  maxLength={500}
                  style={{
                    width: '100%', resize: 'none', background: '#f9fafb', border: '1.5px solid #e5e7eb',
                    borderRadius: 12, padding: '8px 12px', fontSize: 13, color: '#111827',
                    fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
                  }}
                />
              ) : (
                <p style={{ margin: 0, fontSize: 14, color: user.bio ? '#374151' : '#9ca3af' }}>
                  {user.bio || 'No bio yet — tap Edit to add one'}
                </p>
              )}
            </div>

            {/* Phone row */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Phone style={{ width: 16, height: 16, color: '#2563eb' }} />
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ margin: '0 0 2px', fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Phone</p>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#111827' }}>
                  {user.phone.slice(0, 4)}****{user.phone.slice(-4)}
                </p>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a', background: '#dcfce7', borderRadius: 99, padding: '3px 10px' }}>
                Verified
              </span>
            </div>

            {/* Language row */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: editing ? 12 : 0 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Globe style={{ width: 16, height: 16, color: '#7c3aed' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ margin: '0 0 2px', fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Language</p>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#111827' }}>{langLabel}</p>
                </div>
              </div>
              {editing && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {LANGUAGES.map((lang) => (
                    <button
                      key={lang.code}
                      type="button"
                      onClick={() => setLanguage(lang.code)}
                      style={{
                        padding: '9px 12px', borderRadius: 12, border: 'none', cursor: 'pointer',
                        background: language === lang.code ? '#2563eb' : '#f3f4f6',
                        color: language === lang.code ? '#fff' : '#374151',
                        fontSize: 13, fontWeight: 600, textAlign: 'left',
                        fontFamily: 'inherit',
                      }}
                    >
                      {lang.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Security row */}
            <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Shield style={{ width: 16, height: 16, color: '#16a34a' }} />
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ margin: '0 0 2px', fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Security</p>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#111827' }}>Phone-based auth</p>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a' }}>Active</span>
            </div>
          </div>

          {/* Member since */}
          {user.memberSince && (
            <p style={{ textAlign: 'center', fontSize: 12, color: '#9ca3af', margin: '0 0 16px' }}>
              Member since {new Date(user.memberSince).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}
            </p>
          )}

          {/* ── Save / Sign out ── */}
          {editing ? (
            <button
              type="button"
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
              style={{
                width: '100%', height: 52, borderRadius: 14, border: 'none',
                background: '#000', color: '#fff', fontSize: 15, fontWeight: 700,
                cursor: updateMutation.isPending ? 'default' : 'pointer',
                opacity: updateMutation.isPending ? 0.6 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                fontFamily: 'inherit',
              }}
            >
              {updateMutation.isPending
                ? <><Loader2 style={{ width: 18, height: 18, animation: 'spin 1s linear infinite' }} />Saving…</>
                : <><Save style={{ width: 16, height: 16 }} />Save changes</>}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleLogout()}
              style={{
                width: '100%', height: 52, borderRadius: 14,
                border: '1.5px solid #fecaca', background: '#fff',
                color: '#dc2626', fontSize: 15, fontWeight: 700,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                fontFamily: 'inherit',
              }}
            >
              <LogOut style={{ width: 16, height: 16 }} />
              Sign out
            </button>
          )}
        </div>
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </AppShell>
  );
}

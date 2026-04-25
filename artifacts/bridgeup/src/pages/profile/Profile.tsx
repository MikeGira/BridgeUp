import { useState } from 'react';
import { useLocation } from 'wouter';
import { ChevronLeft, LogOut, Edit2, Save, Loader2, Shield, Globe, Phone } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { authApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { AppShell } from '@/components/layout/AppShell';

const ROLE_META: Record<string, { label: string; color: string }> = {
  user:       { label: 'Member',       color: 'bg-blue-100 text-blue-700'    },
  helper:     { label: 'Helper',       color: 'bg-green-100 text-green-700'  },
  admin:      { label: 'Admin',        color: 'bg-violet-100 text-violet-700'},
  ngo:        { label: 'NGO',          color: 'bg-teal-100 text-teal-700'    },
  superadmin: { label: 'Super Admin',  color: 'bg-red-100 text-red-700'      },
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

  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [language, setLanguage] = useState(user?.language ?? 'en');

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

  const roleInfo = ROLE_META[user.role] || ROLE_META.user;

  return (
    <AppShell>
      <div className="flex flex-col h-full bg-background overflow-y-auto">
        <div className="flex items-center gap-3 px-4 pt-12 pb-4">
          <button type="button" onClick={() => navigate('/home')} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-bold flex-1">Profile</h1>
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-muted"
          >
            <Edit2 className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 pb-8 space-y-5">
          {/* Avatar + name */}
          <div className="flex items-center gap-4 p-5 bg-card rounded-2xl border border-border">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-2xl font-bold text-white flex-shrink-0">
              {user.displayName?.[0]?.toUpperCase() ?? user.phone.slice(-2)}
            </div>
            <div className="flex-1 min-w-0">
              {editing ? (
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your name"
                  maxLength={100}
                  className="w-full text-lg font-bold bg-transparent border-b border-primary focus:outline-none pb-0.5"
                />
              ) : (
                <p className="text-xl font-bold">{user.displayName || 'Your Name'}</p>
              )}
              <div className="flex items-center gap-2 mt-1.5">
                <Badge className={`${roleInfo.color} border-0 text-xs`}>{roleInfo.label}</Badge>
                {user.country && <span className="text-xs text-muted-foreground">{user.country}</span>}
              </div>
            </div>
          </div>

          {/* Bio */}
          <div className="p-4 bg-card rounded-2xl border border-border">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">About</p>
            {editing ? (
              <textarea
                rows={3}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Tell the community a bit about yourself…"
                maxLength={500}
                className="w-full text-sm bg-transparent border border-border rounded-xl p-2 resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            ) : (
              <p className="text-sm text-muted-foreground">{user.bio || 'No bio yet'}</p>
            )}
          </div>

          {/* Contact */}
          <div className="p-4 bg-card rounded-2xl border border-border space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Contact</p>
            <div className="flex items-center gap-3">
              <Phone className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm">{user.phone.slice(0, 4)}****{user.phone.slice(-4)}</span>
              <Badge variant="outline" className="ml-auto text-xs text-green-600 border-green-300">Verified</Badge>
            </div>
          </div>

          {/* Language */}
          <div className="p-4 bg-card rounded-2xl border border-border">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Language</p>
            {editing ? (
              <div className="grid grid-cols-2 gap-2">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => setLanguage(lang.code)}
                    className={`px-3 py-2 rounded-xl text-sm text-left transition-colors ${language === lang.code ? 'bg-primary text-white' : 'bg-muted hover:bg-muted/80'}`}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm">{LANGUAGES.find((l) => l.code === user.language)?.label ?? user.language}</span>
              </div>
            )}
          </div>

          {/* Security */}
          <div className="p-4 bg-card rounded-2xl border border-border">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Security</p>
            <div className="flex items-center gap-3">
              <Shield className="w-4 h-4 text-green-600" />
              <span className="text-sm flex-1">Phone-based auth enabled</span>
              <span className="text-xs text-green-600 font-medium">Active</span>
            </div>
          </div>

          {/* Member since */}
          {user.memberSince && (
            <p className="text-xs text-center text-muted-foreground">
              Member since {new Date(user.memberSince).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}
            </p>
          )}

          {/* Save / Logout */}
          {editing ? (
            <Button
              className="w-full h-12 rounded-xl"
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Save className="w-4 h-4 mr-2" />Save changes</>}
            </Button>
          ) : (
            <Button
              variant="outline"
              className="w-full h-12 rounded-xl text-red-600 border-red-200 hover:bg-red-50"
              onClick={() => void handleLogout()}
            >
              <LogOut className="w-4 h-4 mr-2" />Sign out
            </Button>
          )}
        </div>
      </div>
    </AppShell>
  );
}

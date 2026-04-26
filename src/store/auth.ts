import { create } from 'zustand';
import type { User } from '@/lib/api';
import { authApi } from '@/lib/api';

interface AuthState {
  user:          User | null;
  token:         string | null;
  isLoading:     boolean;
  isInitialized: boolean;

  setUser:  (user: User | null) => void;
  setToken: (token: string | null) => void;
  login:    (token: string, user: User) => void;
  logout:   () => Promise<void>;
  refresh:  () => Promise<void>;
}

const TOKEN_KEY = 'bridgeup_token';
const USER_KEY  = 'bridgeup_user';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readToken(): string | null {
  // Also migrate from old sessionStorage (one-time, for users who logged in before the localStorage switch)
  const lt = localStorage.getItem(TOKEN_KEY);
  if (lt) return lt;
  const st = sessionStorage.getItem(TOKEN_KEY);
  if (st) {
    localStorage.setItem(TOKEN_KEY, st);
    sessionStorage.removeItem(TOKEN_KEY);
    return st;
  }
  return null;
}

function readUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

function saveUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function clearStorage(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

// ─── Store ────────────────────────────────────────────────────────────────────
export const useAuthStore = create<AuthState>((set) => ({
  // Both token and user are read from localStorage immediately on startup.
  // isInitialized starts true so ProtectedRoute never shows PageLoader on refresh.
  user:          readUser(),
  token:         readToken(),
  isLoading:     false,
  isInitialized: true,

  setUser:  (user)  => set({ user }),
  setToken: (token) => {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else       localStorage.removeItem(TOKEN_KEY);
    set({ token });
  },

  login: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    saveUser(user);
    set({ token, user, isInitialized: true });
  },

  logout: async () => {
    try { await authApi.logout(); } catch { /* always clear locally */ }
    clearStorage();
    set({ token: null, user: null });
  },

  // Background token validation — runs once on app mount.
  // Does NOT block the UI or clear the user on network errors.
  refresh: async () => {
    const token = readToken();
    if (!token) {
      clearStorage();
      set({ user: null, token: null, isInitialized: true });
      return;
    }
    try {
      const { user } = await authApi.me();
      saveUser(user);
      set({ user, token, isInitialized: true });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 401 || status === 403) {
        // Real auth failure — sign out
        clearStorage();
        set({ user: null, token: null, isInitialized: true });
      }
      // Network / 5xx: keep the cached user — app stays fully usable
    }
  },
}));

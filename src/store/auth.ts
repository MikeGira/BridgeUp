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

// localStorage persists across refreshes and app restarts on mobile
const TOKEN_KEY = 'bridgeup_token';

export const useAuthStore = create<AuthState>((set, get) => ({
  user:          null,
  token:         localStorage.getItem(TOKEN_KEY),
  isLoading:     false,
  isInitialized: false,

  setUser:  (user)  => set({ user }),
  setToken: (token) => {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else       localStorage.removeItem(TOKEN_KEY);
    set({ token });
  },

  login: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    set({ token, user, isInitialized: true });
  },

  logout: async () => {
    try { await authApi.logout(); } catch { /* always clear locally */ }
    localStorage.removeItem(TOKEN_KEY);
    set({ token: null, user: null });
  },

  refresh: async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      set({ user: null, token: null, isInitialized: true, isLoading: false });
      return;
    }
    // Already hydrated from login() — skip the network round-trip
    if (get().user) {
      set({ isInitialized: true });
      return;
    }
    set({ isLoading: true });
    try {
      const { user } = await authApi.me();
      set({ user, token, isInitialized: true, isLoading: false });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 401 || status === 403) {
        // Auth error — clear the invalid token
        localStorage.removeItem(TOKEN_KEY);
        set({ user: null, token: null, isInitialized: true, isLoading: false });
      } else {
        // Network/server error — keep token, don't sign out
        set({ isInitialized: true, isLoading: false });
      }
    }
  },
}));

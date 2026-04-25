import { create } from 'zustand';
import type { User } from '@/lib/api';
import { authApi } from '@/lib/api';

interface AuthState {
  user:         User | null;
  token:        string | null;
  isLoading:    boolean;
  isInitialized: boolean;

  setUser:  (user: User | null) => void;
  setToken: (token: string | null) => void;
  login:    (token: string, user: User) => void;
  logout:   () => Promise<void>;
  refresh:  () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user:          null,
  token:         sessionStorage.getItem('bridgeup_token'),
  isLoading:     false,
  isInitialized: false,

  setUser:  (user)  => set({ user }),
  setToken: (token) => {
    if (token) {
      sessionStorage.setItem('bridgeup_token', token);
    } else {
      sessionStorage.removeItem('bridgeup_token');
    }
    set({ token });
  },

  login: (token, user) => {
    sessionStorage.setItem('bridgeup_token', token);
    set({ token, user, isInitialized: true });
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore errors — always log out locally
    }
    sessionStorage.removeItem('bridgeup_token');
    set({ token: null, user: null });
  },

  refresh: async () => {
    const token = sessionStorage.getItem('bridgeup_token');
    if (!token) {
      set({ user: null, token: null, isInitialized: true, isLoading: false });
      return;
    }
    set({ isLoading: true });
    try {
      const { user } = await authApi.me();
      set({ user, token, isInitialized: true, isLoading: false });
    } catch {
      sessionStorage.removeItem('bridgeup_token');
      set({ user: null, token: null, isInitialized: true, isLoading: false });
    }
  },
}));

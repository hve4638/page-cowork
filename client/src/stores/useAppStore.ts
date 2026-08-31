import { create } from 'zustand';

/**
 * App-wide runtime state
 * Use for ephemeral state that doesn't need persistence
 */
type AppState = {
    isLoading: boolean;
    theme: 'light' | 'dark';
}

type AppActions = {
    setLoading: (loading: boolean) => void;
    setTheme: (theme: 'light' | 'dark') => void;
    toggleTheme: () => void;
}

export const useAppStore = create<AppState & AppActions>((set) => ({
    // State
    isLoading: false,
    theme: 'dark',

    // Actions
    setLoading: (loading) => set({ isLoading: loading }),
    setTheme: (theme) => set({ theme }),
    toggleTheme: () => set((state) => ({
        theme: state.theme === 'dark' ? 'light' : 'dark'
    })),
}));

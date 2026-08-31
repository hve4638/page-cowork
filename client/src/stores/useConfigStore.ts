import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * User configuration state with persistence
 * Use for settings that should survive page reloads
 */
type ConfigState = {
    fontSize: number;
    language: string;
    sidebarOpen: boolean;
}

type ConfigActions = {
    setFontSize: (size: number) => void;
    setLanguage: (lang: string) => void;
    setSidebarOpen: (open: boolean) => void;
    toggleSidebar: () => void;
}

export const useConfigStore = create<ConfigState & ConfigActions>()(
    persist(
        (set) => ({
            // State
            fontSize: 14,
            language: 'ko',
            sidebarOpen: true,

            // Actions
            setFontSize: (fontSize) => set({ fontSize }),
            setLanguage: (language) => set({ language }),
            setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
            toggleSidebar: () => set((state) => ({
                sidebarOpen: !state.sidebarOpen
            })),
        }),
        {
            name: 'config-storage',
        }
    )
);

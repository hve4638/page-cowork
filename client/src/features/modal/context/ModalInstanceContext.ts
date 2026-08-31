import { createContext } from 'react';

interface ModalInstanceState {
    /** Whether this modal is focused (topmost) */
    focused: boolean;
    /** Whether the modal is in disappearing animation */
    disappear: boolean;
    /** Close the modal */
    closeModal: () => void;
}

export const ModalInstanceContext = createContext<ModalInstanceState | null>(null);

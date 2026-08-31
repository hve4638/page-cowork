import { useCallback, useEffect, useState } from 'react';
import { ModalInstanceContext } from './ModalInstanceContext';

const DISAPPEAR_DURATION = 150;

interface ModalInstanceProviderProps {
    children?: React.ReactNode;
    focused: boolean;
    onClose: () => void;
}

export function ModalInstanceProvider({
    children,
    focused,
    onClose
}: ModalInstanceProviderProps) {
    const [disappear, setDisappear] = useState(false);

    const closeModal = useCallback(() => {
        setDisappear(true);
        setTimeout(onClose, DISAPPEAR_DURATION);
    }, [onClose]);

    // Handle Escape key
    useEffect(() => {
        if (!focused) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                closeModal();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [focused, closeModal]);

    return (
        <ModalInstanceContext.Provider
            value={{
                focused,
                disappear,
                closeModal,
            }}
        >
            {children}
        </ModalInstanceContext.Provider>
    );
}

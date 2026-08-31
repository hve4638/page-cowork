import { ReactNode, useRef, useState } from 'react';

import { ModalContext } from './ModalContext';
import { ModalInstanceProvider } from './ModalInstanceProvider';

interface ModalData {
    node: ReactNode;
    key: number;
}

export function ModalProvider({ children }: { children: React.ReactNode }) {
    const counter = useRef(0);
    const [modals, setModals] = useState<ModalData[]>([]);

    const openModal = (node: ReactNode) => {
        setModals((prev) => [...prev, { node, key: counter.current++ }]);
    };

    const closeModal = (modalKey: number) => {
        setModals((prev) => prev.filter((d) => d.key !== modalKey));
    };

    return (
        <ModalContext.Provider value={{
            open: openModal,
            count: modals.length,
        }}>
            {children}
            {modals.map(({ node, key }, index) => (
                <ModalInstanceProvider
                    key={key}
                    focused={index === modals.length - 1}
                    onClose={() => closeModal(key)}
                >
                    {node}
                </ModalInstanceProvider>
            ))}
        </ModalContext.Provider>
    );
}

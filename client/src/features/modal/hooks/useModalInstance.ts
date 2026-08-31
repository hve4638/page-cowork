import { useContext } from 'react';
import { ModalInstanceContext } from '../context/ModalInstanceContext';

export function useModalInstance() {
    const context = useContext(ModalInstanceContext);
    if (!context) {
        throw new Error('useModalInstance must be used within a ModalInstanceProvider');
    }
    return context;
}

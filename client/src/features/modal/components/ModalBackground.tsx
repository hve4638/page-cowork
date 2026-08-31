import { useModalInstance } from '../hooks/useModalInstance';
import styles from './ModalBackground.module.css';
import { cn } from '@/lib/utils';

interface ModalBackgroundProps {
    children?: React.ReactNode;
    onClick?: () => void;
}

export function ModalBackground({ children, onClick }: ModalBackgroundProps) {
    const { disappear, closeModal } = useModalInstance();

    const handleBackgroundClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClick?.();
            closeModal();
        }
    };

    return (
        <div
            className={cn(styles['background'], {
                [styles['disappear']]: disappear,
            })}
            onClick={handleBackgroundClick}
        >
            {children}
        </div>
    );
}

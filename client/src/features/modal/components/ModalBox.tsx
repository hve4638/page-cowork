import { cn } from '@/lib/utils';
import { CommonProps } from '@/types';
import { useModalInstance } from '../hooks/useModalInstance';
import styles from './ModalBox.module.css';

interface ModalBoxProps extends CommonProps {
    children?: React.ReactNode;
}

export function ModalBox({ children, className, style }: ModalBoxProps) {
    const { disappear } = useModalInstance();

    return (
        <div
            className={cn(styles['box'], className, {
                [styles['disappear']]: disappear,
            })}
            style={style}
            onClick={(e) => e.stopPropagation()}
        >
            {children}
        </div>
    );
}

import { cn } from '@/lib/utils';
import { CommonProps, MouseActionProps } from '@/types';
import styles from './styles.module.css';

export interface ButtonProps extends CommonProps, Pick<MouseActionProps<HTMLButtonElement>, 'onClick'> {
    children?: React.ReactNode;
    disabled?: boolean;
    variant?: 'default' | 'green' | 'red' | 'blue' | 'transparent';
}

function Button({
    disabled = false,
    variant = 'default',
    className = '',
    style = {},
    children,
    onClick,
}: ButtonProps) {
    return (
        <button
            className={cn(
                styles['button'],
                'btn-radius',
                variant !== 'default' && styles[variant],
                disabled && styles['disabled'],
                className
            )}
            tabIndex={disabled ? -1 : 0}
            style={style}
            onClick={(e) => {
                if (!disabled && onClick) {
                    onClick(e);
                }
            }}
            onKeyDown={(e) => {
                if (e.key === 'Enter' && !disabled && onClick) {
                    onClick(e as unknown as React.MouseEvent<HTMLButtonElement>);
                    e.stopPropagation();
                }
            }}
        >
            {children}
        </button>
    );
}

export default Button;

import { cn } from '@/lib/utils';
import { CommonProps, KeyboardActionProps, FocusActionProps } from '@/types';
import styles from './styles.module.css';

export interface InputProps extends
    CommonProps,
    KeyboardActionProps<HTMLInputElement>,
    FocusActionProps<HTMLInputElement> {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    type?: 'text' | 'password' | 'email' | 'number';
    onChange?: (value: string) => void;
}

function Input({
    value = '',
    placeholder = '',
    disabled = false,
    type = 'text',
    className = '',
    style = {},
    onChange,
    onKeyDown,
    onKeyUp,
    onFocus,
    onBlur,
}: InputProps) {
    return (
        <input
            type={type}
            className={cn(styles['input'], className, disabled && styles['disabled'])}
            style={style}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange?.(e.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onFocus={onFocus}
            onBlur={onBlur}
        />
    );
}

export default Input;

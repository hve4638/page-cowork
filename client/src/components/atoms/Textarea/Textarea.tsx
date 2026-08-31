import { CommonProps } from '@/types';
import styles from './Textarea.module.css';
import { cn } from '@/lib/utils';

interface TextareaProps extends CommonProps {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}

export function Textarea({
    className,
    style,
    value,
    onChange,
}: TextareaProps) {
    return (
        <textarea
            className={
                cn(styles['textarea'], className)
            }
            style={{...style}}

            value={value}
            onChange={onChange}
        />
    );
}
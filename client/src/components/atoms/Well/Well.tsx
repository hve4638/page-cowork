import { useRef } from 'react';
import { cn } from '@/lib/utils';

import { ReactNodeProps } from '@/types';
import { WellItem } from './WelIItem';


interface WellProps extends ReactNodeProps.Common {
    children?: React.ReactNode;
}

export function Well({
    className,
    style,
    children,
}: WellProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    return (
        <div
            ref={containerRef}
            className={
                cn(
                    'px-1 w-full bg-[var(--bg-well)] rounded-[4px] whitespace-pre-line break-all',
                    className
                )
            }
            style={style}
        >
            {children}
        </div>
    )
}

Well.Item = WellItem;
import React from 'react';
import { cn } from '@/lib/utils';
import { CommonProps } from '@/types';
import styles from './styles.module.css';


interface SubdescriptionProps extends CommonProps {
    children?: React.ReactNode;
}

function Subdescription({
    className = '',
    style = {},
    children
}: SubdescriptionProps) {
    return (
        <div
            className={
                cn(
                    styles['subdescription'],
                    className
                )
            }
            style={{
                ...style,
            }}
        >
            {children}
        </div>
    );
}

export default Subdescription;
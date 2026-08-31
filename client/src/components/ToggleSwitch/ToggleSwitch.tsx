import React, { useEffect, useMemo, useRef, useState } from "react";
import styles from './styles.module.css';

interface ToggleSwitchProps {
    className?:string;
    style?:any;
    enabled?:boolean;
    onChange?:(checked:boolean)=>void;
}

function ToggleSwitch({
    className='',
    style={},
    enabled,
    onChange=(x)=>{}
}:ToggleSwitchProps) {
    const sliderRef = useRef<HTMLDivElement>(null);
    const thumbX = useMemo(()=>{
        if (!enabled || !sliderRef.current) {
            return 0;
        }
        else {
            const rect = sliderRef.current.getBoundingClientRect();
            return rect.width - rect.height;
        }
    }, [sliderRef.current, enabled]);

    return (
        <label
            className={
                styles['toggle-switch']
                + (className ? ' ' + className : '')
            }
            style={{
                ...style,
            }}
        >
            <input
                type='checkbox'
                checked={enabled}
                onChange={(e)=>{
                    onChange(!enabled);
                }}
            />
            <div className={styles['slider']} ref={sliderRef}/>
            <div
                className={styles['thumb']}
                style={{
                    left: thumbX,
                    backgroundColor: enabled ? 'rgb(26, 159, 255)' : undefined,
                }}
            />
        </label>
    );
}

export default ToggleSwitch;
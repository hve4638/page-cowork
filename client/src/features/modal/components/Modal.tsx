import React from 'react';
import FocusLock from 'react-focus-lock';
import { CommonProps } from '@/types';
import { ModalBackground } from './ModalBackground';
import { ModalBox } from './ModalBox';

interface ModalProps extends CommonProps {
    children?: React.ReactNode;
    header?: React.ReactNode;
}

export function Modal({
    className = '',
    style = {},
    children,
    header,
}: ModalProps) {
    return (
        <FocusLock autoFocus={false} returnFocus={false}>
            <ModalBackground>
                <ModalBox
                    className={className}
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        ...style,
                    }}
                >
                    {header && (
                        <div style={{ marginBottom: '16px' }}>
                            {header}
                        </div>
                    )}
                    {children}
                </ModalBox>
            </ModalBackground>
        </FocusLock>
    );
}

export default Modal;

import { useState } from 'react';

/**
 * Simple hook to force a re-render
 * Useful when modifying refs that need to trigger UI updates
 */
export function useRerender() {
    const [ping, setPing] = useState<number>(0);

    return [
        ping,
        () => setPing(prev => prev + 1)
    ] as const;
}

export default useRerender;

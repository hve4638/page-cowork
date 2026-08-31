/**
 * A synchronization primitive that allows multiple async flows to wait for a single release signal
 */
export class Latch {
    #released = false;
    #resolvers: Array<() => void> = [];

    /**
     * Wait until release() is called
     * Returns immediately if already released
     */
    async wait(): Promise<void> {
        if (this.#released) return;

        return new Promise<void>((resolve) => {
            this.#resolvers.push(resolve);
        });
    }

    /**
     * Release all waiting wait() calls
     */
    release(): void {
        if (this.#released) return;
        this.#released = true;

        for (const resolve of this.#resolvers) {
            resolve();
        }
        this.#resolvers = [];
    }

    /**
     * Check if the latch has been released
     */
    get isReleased(): boolean {
        return this.#released;
    }
}

export default Latch;

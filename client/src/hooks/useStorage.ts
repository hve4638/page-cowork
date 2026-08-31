import { useState, useEffect, useCallback } from 'react';

type StorageArgs<T> = {
    store: (key: string, value: T) => Promise<void>;
    load: (key: string) => Promise<T>;
    onStoreError?: (error: unknown) => void;
    onLoadError?: (error: unknown) => void;
    encode?: (value: any) => T | undefined;
    decode?: (value: T) => any;
}

/**
 * Generic storage hook for async read/write operations
 * @param key - Storage key
 * @param args - Storage configuration
 * @param deps - Dependencies for re-fetching
 */
export function useStorage<T>(
    key: string,
    {
        encode,
        decode,
        onStoreError = (error: unknown) => console.error(error),
        onLoadError = (error: unknown) => console.error(error),
        store,
        load,
    }: StorageArgs<T>,
    deps: any[] | undefined = undefined
): [any, (value: any) => Promise<void>, () => Promise<void>] {
    const [cacheValue, setCacheValue] = useState<any>(undefined);

    const refetchCache = useCallback(async () => {
        try {
            const data = await load(key);
            const cache = decode ? decode(data) : data;
            setCacheValue(cache);
            return cache;
        }
        catch (err) {
            onLoadError(err);
            setCacheValue(undefined)
            return undefined;
        }
    }, [key, decode, load, onLoadError]);

    const writeValue = useCallback(async (value: any) => {
        const prev = cacheValue;
        const next = typeof value === 'function' ? value(prev) : value;

        try {
            await store(key, encode ? encode(next) : next);
            setCacheValue(next);
        }
        catch (err) {
            onStoreError(err);
            refetchCache();
        }
        return next;
    }, [key, encode, store, onStoreError, refetchCache]);

    useEffect(() => {
        refetchCache();
    }, deps);

    return [cacheValue, writeValue, refetchCache];
}

import type { QueryValue } from '@shared/query';

/** Convert database-driver values into values that are safe to send over Electron IPC. */
export function toQueryValue(value: unknown): QueryValue {
    if (value == null) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString('base64');
    if (value instanceof ArrayBuffer) return Buffer.from(value).toString('base64');
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
    try {
        const json = JSON.stringify(value);
        if (json !== undefined) return json;
    } catch {
        // A cyclic driver value is still represented safely below.
    }
    return String(value);
}

export function toQueryRow(values: readonly unknown[]): QueryValue[] {
    return values.map(toQueryValue);
}

export type MessageResult<T> = { ok: true; output: T; summary?: string } | { ok: false; code: string; message: string };
export const messageFailure = (code: string, message: string): MessageResult<never> => ({ ok: false, code, message });

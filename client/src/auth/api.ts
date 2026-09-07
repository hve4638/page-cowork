// 인증 관련 HTTP 호출. 세션은 HttpOnly 쿠키라 클라이언트는 토큰을 직접 다루지 않는다.
export type Me = { id: string; email: string; login_id: string; name?: string | null; role: 'admin' | 'member' };
export const displayName = (u: { login_id: string; name?: string | null }) => u.name || u.login_id; // 표시 이름이 없으면 아이디
export type PendingUser = { id: string; email: string; login_id: string; created_at: number };

type ApiResult = { ok: boolean; data: { error?: string; [key: string]: unknown } };

async function post(path: string, body?: unknown): Promise<ApiResult> {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
}

export async function fetchMe(): Promise<Me | null> {
    const res = await fetch('/api/me');
    if (!res.ok) return null;
    return (await res.json()).user as Me;
}

export const login = (login_id: string, pw: string) => post('/api/login', { login_id, pw });
export const signup = (email: string, login_id: string, pw: string) => post('/api/signup', { email, login_id, pw });
export const logout = () => post('/api/logout');
export async function setMyName(name: string): Promise<Me | null> {
    const r = await post('/api/me/name', { name });
    return r.ok ? (r.data['user'] as Me) : null;
}

export async function fetchPending(): Promise<PendingUser[]> {
    const res = await fetch('/api/admin/pending');
    if (!res.ok) return [];
    return (await res.json()).users as PendingUser[];
}
export const approve = (user_id: string) => post('/api/admin/approve', { user_id });

export type AdminUser = {
    id: string; email: string; login_id: string;
    role: 'admin' | 'member'; status: 'pending' | 'active'; created_at: number;
};
export async function fetchUsers(): Promise<AdminUser[]> {
    const res = await fetch('/api/admin/users');
    if (!res.ok) return [];
    return (await res.json()).users as AdminUser[];
}

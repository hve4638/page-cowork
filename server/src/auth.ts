// 계정·세션·화이트리스트. 비밀번호는 계정별 무작위 salt 를 붙여 scrypt 로 저장한다.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { db } from './db.ts';

export type User = {
    id: string;
    email: string;
    login_id: string;
    role: 'admin' | 'member';
    status: 'pending' | 'active';
};

export const rid = (bytes: number) => randomBytes(bytes).toString('hex');

export const hashPw = (pw: string, salt: string) => scryptSync(pw, salt, 64).toString('hex');

export function verifyPw(pw: string, salt: string, expectedHash: string): boolean {
    const actual = Buffer.from(hashPw(pw, salt));
    const expected = Buffer.from(expectedHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// 화이트리스트는 DB 가 아니라 텍스트 파일이다 (한 줄에 이메일 하나). 관리자가 파일을 직접 편집하므로 매번 읽는다.
const WHITELIST_PATH = fileURLToPath(new URL('../whitelist.txt', import.meta.url));
export function isWhitelisted(email: string): boolean {
    let raw: string;
    try { raw = readFileSync(WHITELIST_PATH, 'utf8'); } catch { return false; }
    return raw.split('\n').map(line => line.trim()).filter(Boolean).includes(email);
}

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function createSession(userId: string): string {
    const token = rid(32);
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
        .run(token, userId, Date.now() + SESSION_TTL_MS);
    return token;
}

export function deleteSession(token: string): void {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
    return out;
}

export function sessionToken(req: IncomingMessage): string | null {
    return parseCookies(req)['session'] ?? null;
}

// 개발용 자동 로그인: DEV_AUTO_LOGIN=<login_id> 가 있으면 세션이 없거나 무효한 요청을 그 사용자로 취급한다.
// 데모 서버가 같은 IP 의 여러 포트에 떠서 세션 쿠키가 서로 덮어써지는 불편을 피하기 위한 것이고, 변수가 없으면 이 경로는 타지 않는다.
const DEV_AUTO_LOGIN = process.env.DEV_AUTO_LOGIN;
if (DEV_AUTO_LOGIN) console.log(`[dev] DEV_AUTO_LOGIN=${DEV_AUTO_LOGIN}: 세션 없는 요청을 이 사용자로 취급한다`);

function devAutoLoginUser(loginId: string): User | null {
    const row = db.prepare(
        "SELECT id, email, login_id, role, status FROM users WHERE login_id = ? AND status = 'active'",
    ).get(loginId) as User | undefined;
    return row ?? null;
}

// HTTP 요청과 WS 업그레이드 요청이 같은 함수로 인증된다
export function sessionUser(req: IncomingMessage): User | null {
    const user = cookieSessionUser(req);
    if (!user && DEV_AUTO_LOGIN) return devAutoLoginUser(DEV_AUTO_LOGIN);
    return user;
}

function cookieSessionUser(req: IncomingMessage): User | null {
    const token = sessionToken(req);
    if (!token) return null;
    const row = db.prepare(`
        SELECT u.id, u.email, u.login_id, u.role, u.status, s.expires_at
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
    `).get(token) as (User & { expires_at: number }) | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) { deleteSession(token); return null; }
    return { id: row.id, email: row.email, login_id: row.login_id, role: row.role, status: row.status };
}

// HTTP 라우트: 가입 신청·로그인·세션. 라우트 목록은 docs/2026-08-30-cowork-schema-draft.md 와 같다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import {
    createSession, deleteSession, hashPw, isWhitelisted, rid,
    sessionToken, sessionUser, verifyPw,
} from './auth.ts';

const BODY_LIMIT = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > BODY_LIMIT) return null;
        chunks.push(chunk as Buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'POST /api/signup') {
        const body = await readJson(req);
        const email = str(body?.email), loginId = str(body?.login_id);
        const pw = typeof body?.pw === 'string' ? body.pw : '';
        if (!email || !loginId || pw.length < 4) {
            return json(res, 400, { error: '이메일·아이디를 입력하고, 비밀번호는 4자 이상이어야 합니다.' });
        }
        if (!isWhitelisted(email)) {
            return json(res, 403, { error: '가입이 허용되지 않은 이메일입니다.' });
        }
        const salt = rid(16);
        try {
            db.prepare(`
                INSERT INTO users (id, email, login_id, pw_hash, pw_salt, role, status, created_at)
                VALUES (?, ?, ?, ?, ?, 'member', 'pending', ?)
            `).run(rid(8), email, loginId, hashPw(pw, salt), salt, Date.now());
        } catch {
            return json(res, 409, { error: '이미 가입 신청된 이메일 또는 아이디입니다.' });
        }
        return json(res, 200, { ok: true, status: 'pending' });
    }

    if (route === 'POST /api/login') {
        const body = await readJson(req);
        const loginId = str(body?.login_id);
        const pw = typeof body?.pw === 'string' ? body.pw : '';
        const user = db.prepare('SELECT * FROM users WHERE login_id = ?').get(loginId) as
            | { id: string; email: string; login_id: string; pw_hash: string; pw_salt: string; role: string; status: string }
            | undefined;
        if (!user || !verifyPw(pw, user.pw_salt, user.pw_hash)) {
            return json(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
        }
        if (user.status !== 'active') {
            return json(res, 403, { error: '아직 승인 대기 중인 계정입니다.' });
        }
        const token = createSession(user.id);
        res.setHeader('set-cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
        return json(res, 200, { user: { id: user.id, email: user.email, login_id: user.login_id, role: user.role } });
    }

    if (route === 'POST /api/logout') {
        const token = sessionToken(req);
        if (token) deleteSession(token);
        res.setHeader('set-cookie', 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
        return json(res, 200, { ok: true });
    }

    if (route === 'GET /api/me') {
        const user = sessionUser(req);
        if (!user || user.status !== 'active') return json(res, 401, { error: '로그인이 필요합니다.' });
        return json(res, 200, { user: { id: user.id, email: user.email, login_id: user.login_id, role: user.role } });
    }

    if (route === 'GET /api/admin/pending' || route === 'POST /api/admin/approve' || route === 'GET /api/admin/users') {
        const user = sessionUser(req);
        if (!user || user.role !== 'admin') return json(res, 403, { error: '관리자만 사용할 수 있습니다.' });
        if (route === 'GET /api/admin/users') {
            const rows = db.prepare(
                'SELECT id, email, login_id, role, status, created_at FROM users ORDER BY created_at',
            ).all();
            return json(res, 200, { users: rows });
        }
        if (route === 'GET /api/admin/pending') {
            const rows = db.prepare(
                "SELECT id, email, login_id, created_at FROM users WHERE status = 'pending' ORDER BY created_at",
            ).all();
            return json(res, 200, { users: rows });
        }
        const body = await readJson(req);
        const userId = str(body?.user_id);
        const changed = db.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'").run(userId).changes;
        if (!changed) return json(res, 404, { error: '승인 대기 중인 해당 사용자가 없습니다.' });
        return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
}

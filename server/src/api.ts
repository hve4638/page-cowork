// HTTP 라우트: 가입 신청·로그인·세션·파일 업로드/다운로드. 라우트 목록은 docs/2026-08-30-cowork-schema-draft.md 와 같다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from './db.ts';
import type { Mutation } from './sync.ts';
import {
    createSession, deleteSession, hashPw, isWhitelisted, rid,
    sessionToken, sessionUser, verifyPw,
} from './auth.ts';

const BODY_LIMIT = 64 * 1024;

// 파일 저장 정책: docs/2026-09-02-cowork-db-schema.md. 실체는 server/data/files/<id>, 상한 50MB, 확장자 제한 없음.
// inline(브라우저에서 바로 열기)은 image/* 와 PDF 만 허용하고 나머지는 attachment 로 강제 다운로드한다.
const FILE_LIMIT = 50 * 1024 * 1024;
const FILES_DIR = fileURLToPath(new URL('../data/files/', import.meta.url));
mkdirSync(FILES_DIR, { recursive: true });
const filePath = (id: string) => FILES_DIR + id;
const isInlineMime = (mime: string) => mime.startsWith('image/') || mime === 'application/pdf';
// 헤더에 넣을 수 있는 mime 문자열만 통과시킨다 (type/subtype, 제어문자·헤더 구분자 없음)
const safeMime = (v: string) => (/^[\w.+-]+\/[\w.+-]+$/.test(v) ? v : 'application/octet-stream');

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

// 원본은 raw body 로 받는다 (multipart 파서 없이). 파일명은 X-File-Name 헤더에 URI 인코딩, mime 은 Content-Type.
// 디스크에 흘려 쓰다가 상한을 넘으면 파일을 지우고 413 을 돌려준다.
async function uploadFile(req: IncomingMessage, res: ServerResponse, userId: string, publish: (m: Mutation) => void): Promise<void> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > FILE_LIMIT) return json(res, 413, { error: '파일이 50MB 를 넘어 업로드할 수 없습니다.' });
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).trim(); } catch { /* 잘못된 인코딩 */ }
    if (!name) return json(res, 400, { error: '파일 이름이 없습니다.' });
    const mime = safeMime(String(req.headers['content-type'] ?? '').split(';')[0].trim());

    const id = rid(8);
    const tmp = filePath(id) + '.part';
    const out = createWriteStream(tmp);
    let size = 0, over = false;
    try {
        for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > FILE_LIMIT) { over = true; break; }
            if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', () => r()));
        }
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* 이미 없음 */ }
        throw err;
    }
    if (over) {
        unlinkSync(tmp);
        return json(res, 413, { error: '파일이 50MB 를 넘어 업로드할 수 없습니다.' });
    }
    renameSync(tmp, filePath(id));
    const row = { id, name, mime, size, author_id: userId, created_at: Date.now() };
    db.prepare('INSERT INTO files (id, name, mime, size, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.id, row.name, row.mime, row.size, row.author_id, row.created_at);
    publish({ action: 'insert', table: 'files', row }); // 다른 클라이언트도 파일명·크기를 바로 보게 한다
    return json(res, 200, { file: row });
}

function downloadFile(res: ServerResponse, id: string, forceDownload: boolean): void {
    const row = db.prepare('SELECT name, mime, size FROM files WHERE id = ?').get(id) as
        { name: string; mime: string; size: number } | undefined;
    if (!row) return json(res, 404, { error: '파일이 없습니다.' });
    const path = filePath(id);
    let stat;
    try { stat = statSync(path); } catch { return json(res, 404, { error: '파일 실체가 없습니다.' }); }
    const disposition = !forceDownload && isInlineMime(row.mime) ? 'inline' : 'attachment';
    // 한글 파일명은 RFC 5987 filename* 로, ascii 로 표현 가능한 부분만 filename 폴백에 넣는다
    const ascii = row.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.writeHead(200, {
        'content-type': row.mime,
        'content-length': stat.size,
        'content-disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        'x-content-type-options': 'nosniff',
    });
    createReadStream(path).pipe(res);
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, publish: (m: Mutation) => void): Promise<void> {
    const route = `${req.method} ${url.pathname}`;

    // 파일: 업로드는 POST /api/files, 다운로드는 GET /api/files/<id> (?download=1 이면 inline 가능해도 attachment)
    if (route === 'POST /api/files' || (req.method === 'GET' && url.pathname.startsWith('/api/files/'))) {
        const user = sessionUser(req);
        if (!user || user.status !== 'active') return json(res, 401, { error: '로그인이 필요합니다.' });
        if (req.method === 'POST') return uploadFile(req, res, user.id, publish);
        const id = url.pathname.slice('/api/files/'.length);
        if (!/^[0-9a-f]+$/.test(id)) return json(res, 404, { error: '파일이 없습니다.' });
        return downloadFile(res, id, url.searchParams.has('download'));
    }

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

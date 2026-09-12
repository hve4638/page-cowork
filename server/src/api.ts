// HTTP 라우트: 가입 신청·로그인·세션·파일 업로드/다운로드. 라우트 목록은 docs/2026-08-30-cowork-schema-draft.md 와 같다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { db } from './db.ts';
import { FILES_DIR } from './config.ts';
import { deleteFileRow, orphanFiles, type Mutation } from './sync.ts';
import { handleRecordingApi } from './recordings.ts';
import {
    createSession, deleteSession, hashPw, isWhitelisted, rid,
    sessionToken, sessionUser, verifyPw,
} from './auth.ts';

const BODY_LIMIT = 64 * 1024;

// 파일 저장 정책: docs/2026-09-02-cowork-db-schema.md. 실체는 <dataDir>/files/<id>, 상한 50MB, 확장자 제한 없음.
// inline(브라우저에서 바로 열기)은 image/*·audio/*(녹음 재생) 와 PDF 만 허용하고 나머지는 attachment 로 강제 다운로드한다.
const FILE_LIMIT = 50 * 1024 * 1024;
mkdirSync(FILES_DIR, { recursive: true });
const filePath = (id: string) => FILES_DIR + id;
const isInlineMime = (mime: string) => mime.startsWith('image/') || mime.startsWith('audio/') || mime === 'application/pdf';
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

// Range 요청을 받는다 (206). 브라우저는 Range 를 못 받는 미디어를 탐색 불가로 취급해 <audio> 의 seek 이 안 되므로,
// 녹음 재생을 위해 필요하다. 지원 형태는 bytes=start-end · bytes=start- · bytes=-suffix 하나뿐이고 여러 구간은 받지 않는다.
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m || (!m[1] && !m[2])) return 'bad';
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (!m[1]) start = Math.max(0, start);
    if (start > end || start >= size) return 'bad';
    return { start, end };
}

function downloadFile(req: IncomingMessage, res: ServerResponse, id: string, forceDownload: boolean): void {
    const row = db.prepare('SELECT name, mime, size FROM files WHERE id = ?').get(id) as
        { name: string; mime: string; size: number } | undefined;
    if (!row) return json(res, 404, { error: '파일이 없습니다.' });
    const path = filePath(id);
    let stat;
    try { stat = statSync(path); } catch { return json(res, 404, { error: '파일 실체가 없습니다.' }); }
    const disposition = !forceDownload && isInlineMime(row.mime) ? 'inline' : 'attachment';
    // 한글 파일명은 RFC 5987 filename* 로, ascii 로 표현 가능한 부분만 filename 폴백에 넣는다
    const ascii = row.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const headers: Record<string, string | number> = {
        'content-type': row.mime,
        'content-disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        'x-content-type-options': 'nosniff',
        'accept-ranges': 'bytes',
    };
    const range = parseRange(req.headers.range, stat.size);
    if (range === 'bad') {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
        return;
    }
    if (range) {
        res.writeHead(206, { ...headers, 'content-length': range.end - range.start + 1, 'content-range': `bytes ${range.start}-${range.end}/${stat.size}` });
        createReadStream(path, { start: range.start, end: range.end }).pipe(res);
        return;
    }
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    createReadStream(path).pipe(res);
}

// 파일 GC: sync.ts 의 orphanFiles 가 고른 파일의 행과 실체를 지운다 (2026-09-08 undo-model, 스키마 문서 files 절)
export function gcFiles(publish: (m: Mutation) => void): void {
    const ids = orphanFiles();
    if (!ids.length) return;
    const group = `gc:${Date.now()}`;
    for (const id of ids) {
        for (const m of deleteFileRow(id, group)) publish(m);
        rmSync(filePath(id), { force: true });
    }
    console.log(`[gc] 미참조 파일 ${ids.length}개 삭제`);
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
        return downloadFile(req, res, id, url.searchParams.has('download'));
    }

    // 회의 녹음: 청크 추가·종료. 상세는 recordings.ts
    if (url.pathname.startsWith('/api/recordings/')) {
        const user = sessionUser(req);
        if (!user || user.status !== 'active') return json(res, 401, { error: '로그인이 필요합니다.' });
        if (await handleRecordingApi(req, res, url, user.id, publish)) return;
    }

    // 활동 중인 사용자 목록 (id·name). 회의록 템플릿이 팀원별 탭을 채우는 데 쓴다. 이메일·역할은 admin 라우트에서만 내려간다.
    if (route === 'GET /api/users') {
        const user = sessionUser(req);
        if (!user || user.status !== 'active') return json(res, 401, { error: '로그인이 필요합니다.' });
        const rows = db.prepare("SELECT id, name FROM users WHERE status = 'active' ORDER BY created_at").all();
        return json(res, 200, { users: rows });
    }

    // 내 닉네임 변경. 빈 값과 중복은 거부한다
    if (route === 'POST /api/me/name') {
        const user = sessionUser(req);
        if (!user || user.status !== 'active') return json(res, 401, { error: '로그인이 필요합니다.' });
        const body = await readJson(req);
        const name = str(body?.name).slice(0, 40);
        if (!name) return json(res, 400, { error: '닉네임을 입력해 주세요.' });
        try {
            db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
        } catch {
            return json(res, 409, { error: '이미 사용 중인 닉네임입니다.' });
        }
        return json(res, 200, { user: { id: user.id, email: user.email, name, role: user.role } });
    }

    if (route === 'POST /api/signup') {
        const body = await readJson(req);
        const email = str(body?.email), name = str(body?.name).slice(0, 40);
        const pw = typeof body?.pw === 'string' ? body.pw : '';
        if (!email || !name || pw.length < 4) {
            return json(res, 400, { error: '이메일·닉네임을 입력하고, 비밀번호는 4자 이상이어야 합니다.' });
        }
        if (!isWhitelisted(email)) {
            return json(res, 403, { error: '가입이 허용되지 않은 이메일입니다.' });
        }
        const salt = rid(16);
        try {
            db.prepare(`
                INSERT INTO users (id, email, name, pw_hash, pw_salt, role, status, created_at)
                VALUES (?, ?, ?, ?, ?, 'member', 'pending', ?)
            `).run(rid(8), email, name, hashPw(pw, salt), salt, Date.now());
        } catch {
            return json(res, 409, { error: '이미 가입 신청된 이메일 또는 사용 중인 닉네임입니다.' });
        }
        return json(res, 200, { ok: true, status: 'pending' });
    }

    if (route === 'POST /api/login') {
        const body = await readJson(req);
        const email = str(body?.email);
        const pw = typeof body?.pw === 'string' ? body.pw : '';
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
            | { id: string; email: string; name: string; pw_hash: string; pw_salt: string; role: string; status: string }
            | undefined;
        if (!user || !verifyPw(pw, user.pw_salt, user.pw_hash)) {
            return json(res, 401, { error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
        }
        if (user.status !== 'active') {
            return json(res, 403, { error: '아직 승인 대기 중인 계정입니다.' });
        }
        const token = createSession(user.id);
        res.setHeader('set-cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
        return json(res, 200, { user: { id: user.id, email: user.email, name: user.name, role: user.role } });
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
        return json(res, 200, { user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    }

    if (route === 'GET /api/admin/pending' || route === 'POST /api/admin/approve' || route === 'GET /api/admin/users') {
        const user = sessionUser(req);
        if (!user || user.role !== 'admin') return json(res, 403, { error: '관리자만 사용할 수 있습니다.' });
        if (route === 'GET /api/admin/users') {
            const rows = db.prepare(
                'SELECT id, email, name, role, status, created_at FROM users ORDER BY created_at',
            ).all();
            return json(res, 200, { users: rows });
        }
        if (route === 'GET /api/admin/pending') {
            const rows = db.prepare(
                "SELECT id, email, name, created_at FROM users WHERE status = 'pending' ORDER BY created_at",
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

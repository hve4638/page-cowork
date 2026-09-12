// 첫 admin 계정 생성: pnpm seed-admin <email> <nickname> <pw>
// 이미 같은 이메일이 있으면 비밀번호를 갈아끼우고 admin·active 로 승격한다.
import { db } from '../src/db.ts';
import { hashPw, rid } from '../src/auth.ts';

const [email, name, pw] = process.argv.slice(2);
if (!email || !name || !pw) {
    console.error('사용법: pnpm seed-admin <email> <nickname> <pw>');
    process.exit(1);
}

const salt = rid(16);
db.prepare(`
    INSERT INTO users (id, email, name, pw_hash, pw_salt, role, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?)
    ON CONFLICT(email) DO UPDATE SET
        name = excluded.name,
        pw_hash = excluded.pw_hash,
        pw_salt = excluded.pw_salt,
        role = 'admin',
        status = 'active'
`).run(rid(8), email, name, hashPw(pw, salt), salt, Date.now());

console.log(`admin 계정 준비 완료: ${name} (${email})`);

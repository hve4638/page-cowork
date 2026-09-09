// 데이터 디렉터리 백업: pnpm backup <목적지>
// 서버가 켜진 상태(WAL)에서도 일관된 DB 사본을 node:sqlite backup API 로 만들고 files/·recordings/·whitelist.txt 를 함께 복사한다.
// 결과 <목적지>/<타임스탬프>/ 는 그대로 dataDir 로 지정해 띄울 수 있는 완전한 데이터 디렉터리다.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { config, DB_PATH } from '../src/config.ts';

const dest = process.argv[2];
if (!dest) {
    console.error('사용법: pnpm backup <목적지 디렉터리>');
    process.exit(1);
}
if (!existsSync(DB_PATH)) {
    console.error(`DB 가 없습니다: ${DB_PATH}`);
    process.exit(1);
}

const now = new Date();
const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace(/[:.]/g, '-').slice(0, 19); // 현지 시각
const out = resolve(dest, stamp);
mkdirSync(out, { recursive: true });

const src = new DatabaseSync(DB_PATH, { readOnly: true });
await backup(src, join(out, 'cowork.db'));
src.close();

for (const name of ['files', 'recordings', 'whitelist.txt']) {
    const from = join(config.dataDir, name);
    if (existsSync(from)) cpSync(from, join(out, name), { recursive: true });
}
console.log(`백업 완료: ${out}`);

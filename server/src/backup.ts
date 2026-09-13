// 데이터 디렉터리 백업. pnpm backup 스크립트와 기동 시 마이그레이션 전 자동 백업(db.ts)이 함께 쓴다.
// 서버가 켜진 상태(WAL)에서도 일관된 DB 사본을 node:sqlite backup API 로 만들고 files/·recordings/·whitelist.txt·admin.txt 를 함께 복사한다.
// 결과 디렉터리는 그대로 dataDir 로 지정해 띄울 수 있는 완전한 데이터 디렉터리다. 이름을 골라 복사하므로 dataDir 안의 backups/ 는 사본에 들어가지 않는다.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { config, DB_PATH } from './config.ts';

// 현지 시각 YYYY-MM-DDTHH-MM-SS (디렉터리 이름용)
export function timestamp(now = new Date()) {
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// out 디렉터리에 사본을 만든다. source 를 주면 그 연결에서 DB 를 뜨고(기동 중인 db.ts), 없으면 DB_PATH 를 읽기 전용으로 연다.
export async function backupDataDir(out: string, source?: DatabaseSync) {
    mkdirSync(out, { recursive: true });
    const src = source ?? new DatabaseSync(DB_PATH, { readOnly: true });
    try { await backup(src, join(out, 'cowork.db')); }
    finally { if (!source) src.close(); }
    for (const name of ['files', 'recordings', 'whitelist.txt', 'admin.txt']) {
        const from = join(config.dataDir, name);
        if (existsSync(from)) cpSync(from, join(out, name), { recursive: true });
    }
    return out;
}

// 데이터 디렉터리 백업: pnpm backup <목적지>
// 결과 <목적지>/<타임스탬프>/ 는 그대로 dataDir 로 지정해 띄울 수 있는 완전한 데이터 디렉터리다. 로직은 src/backup.ts.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DB_PATH } from '../src/config.ts';
import { backupDataDir, timestamp } from '../src/backup.ts';

const dest = process.argv[2];
if (!dest) {
    console.error('사용법: pnpm backup <목적지 디렉터리>');
    process.exit(1);
}
if (!existsSync(DB_PATH)) {
    console.error(`DB 가 없습니다: ${DB_PATH}`);
    process.exit(1);
}

const out = await backupDataDir(resolve(dest, timestamp()));
console.log(`백업 완료: ${out}`);

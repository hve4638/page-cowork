// 아카이브에서 데이터 디렉터리 복원: pnpm restore <아카이브.tar.gz>. 서버가 멈춰 있어야 한다.
// 파일 이름만 주면(경로 구분자 없음) <dataDir>/backups/ 에서 찾는다. 컨테이너 안팎의 경로를 사용자가 조합하지 않게 하기 위해서다.
// 현재 데이터는 <dataDir>/backups/<타임스탬프>-pre-restore/ 로 옮겨 둔다. 로직은 src/backup.ts.
import { resolve } from 'node:path';
import { dataPath } from '../src/config.ts';
import { restoreArchive } from '../src/backup.ts';

const archive = process.argv[2];
if (!archive) {
    console.error('사용법: pnpm restore <아카이브.tar.gz>   (이름만 주면 <dataDir>/backups/ 에서 찾는다)');
    process.exit(1);
}
const path = archive.includes('/') ? resolve(archive) : dataPath('backups', archive);
try {
    const pre = await restoreArchive(path);
    console.log(`복원 완료: ${path}`);
    if (pre) console.log(`복원 전 데이터: ${pre}`);
    console.log('서버를 띄우면 필요한 마이그레이션이 적용됩니다 (docker compose start cowork). 로그인 세션도 백업 시점으로 돌아갑니다.');
} catch (err) {
    console.error(`복원 실패: ${(err as Error).message}`);
    console.error('데이터는 바뀌지 않았습니다.');
    process.exit(1);
}

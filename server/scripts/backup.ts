// 데이터 디렉터리 백업: pnpm backup [목적지 디렉터리]. 목적지를 생략하면 <dataDir>/backups/.
// 결과는 cowork-backup-YYMMDD-HHMMSS-v<번호>-live|cold.tar.gz 하나다. 빈 디렉터리에 tar -xzf 로 풀면 그대로 dataDir 이 된다. 로직은 src/backup.ts.
import { resolve } from 'node:path';
import { dataPath } from '../src/config.ts';
import { backupArchive } from '../src/backup.ts';

try {
    const { path, mode } = await backupArchive(resolve(process.argv[2] ?? dataPath('backups')));
    console.log(`백업 완료: ${path}`);
    if (mode === 'live') console.log('서버가 켜진 상태에서 받은 백업(live)입니다. 받는 동안 끝난 녹음·업로드는 빠지거나 어긋날 수 있습니다. 확실한 사본은 서버를 멈추고 받으세요(cold).');
} catch (err) {
    console.error(`백업 실패: ${(err as Error).message}`);
    process.exit(1);
}

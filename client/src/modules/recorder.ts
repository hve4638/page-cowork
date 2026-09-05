// 회의 녹음기 — 앱 수준 스토어. MediaRecorder·마이크 스트림·업로드 대기열을 패널이 아니라 여기 두어, 패널을 닫거나
// 다른 페이지로 옮겨도 녹음이 이어진다. 한 탭에는 진행 중인 녹음이 하나뿐이고, 조작(일시정지·재개·종료)도 그 탭에서만 한다.
// 상태(status·duration_ms·segment_started_at)는 recordings 테이블로 WS 동기화해 다른 사용자가 경과 시간을 계산하고,
// 소리 청크는 5초마다 HTTP 로 서버에 이어 붙인다. 네트워크가 끊기면 청크는 메모리 큐에 쌓였다가 순서대로 다시 보낸다.
// 녹음 중에는 beforeunload 로 새로고침·탭 닫기를 한 번 확인한다.
import { create } from 'zustand';
import { rid } from '@/sync/store';
import { table } from '@/sync/handle';

export type RecordingRow = {
    id: string;
    title: string;
    status: 'recording' | 'paused' | 'stopped';
    started_by?: string; // 이하 서버가 찍는다
    started_at: number;
    duration_ms: number; // 확정된 누적 녹음 시간 (현재 구간 제외)
    segment_started_at: number | null; // 현재 구간 시작. 일시정지·종료면 null
    file_id?: string | null; // 종료 후 완성 파일 (files.id)
    last_chunk_at?: number | null; // 녹음자 브라우저의 마지막 신호
    created_at?: number;
    updated_at?: number;
};
export type MarkRow = { id: string; recording_id: string; offset_ms: number; text: string; author_id?: string; created_at?: number };

// 지금 시각 기준 경과 시간. 녹음 중이면 현재 구간을 더한다
export const elapsedMs = (r: RecordingRow, now = Date.now()) =>
    r.duration_ms + (r.status === 'recording' && r.segment_started_at ? Math.max(0, now - r.segment_started_at) : 0);
export const fmtClock = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return h ? `${h}:${mmss}` : mmss;
};
export const defaultTitle = (d = new Date()) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `회의 녹음 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const TIMESLICE_MS = 5000; // 청크 주기. 짧을수록 브라우저가 죽었을 때 잃는 구간이 짧다
const BITRATE = 32000; // 음성 회의용. 1시간 약 14MB
const RETRY_MS = 2000;
const HEARTBEAT_MS = 60 * 1000; // 일시정지 중에도 살아 있음을 알린다 (서버는 1시간 무신호면 자동 종료)

const recordings = table<RecordingRow>('recordings', 'rw');

// 이 탭의 녹음기 실체. React 가 볼 필요 없는 것들은 스토어 밖에 둔다
let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let audioCtx: AudioContext | null = null; // 입력 레벨 미터용. 녹음(MediaRecorder)과는 별개로 같은 스트림을 분석만 한다
let analyser: AnalyserNode | null = null;
let levelBuf: Float32Array | null = null;
let queue: Blob[] = [];
let pumping = false;
let segmentStart = 0, accumulated = 0; // 녹음자 탭이 시간 계산의 원본이다
let heartbeat: ReturnType<typeof setInterval> | null = null;
const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };

type RecorderStore = {
    id: string | null; // 이 탭이 녹음기를 들고 있는 녹음. null 이면 이 탭은 녹음 중이 아니다
    paused: boolean;
    start: (title: string) => Promise<string | null>; // 만든 녹음 id. 실패(권한 거부·연결 끊김)면 null
    pause: () => void;
    resume: () => void;
    stop: () => Promise<void>;
};

// 지금 마이크에 들어오는 소리 크기 0..1 (RMS). 이 탭이 녹음 중이 아니면 0. 패널의 레벨 미터가 프레임마다 읽는다.
export function inputLevel(): number {
    if (!analyser || !levelBuf) return 0;
    analyser.getFloatTimeDomainData(levelBuf);
    let sum = 0;
    for (const v of levelBuf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / levelBuf.length) * 4); // 말소리 RMS 는 0.05~0.2 남짓이라 4배로 키워 보인다
}

export const useRecorder = create<RecorderStore>((set, get) => {
    const release = () => {
        stream?.getTracks().forEach(t => t.stop());
        void audioCtx?.close();
        audioCtx = null; analyser = null; levelBuf = null;
        recorder = null; stream = null; queue = [];
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        window.removeEventListener('beforeunload', onBeforeUnload);
        set({ id: null, paused: false });
    };
    // 큐 앞의 청크부터 하나씩 순서대로 올린다. 서버 오류·네트워크 단절이면 기다렸다 같은 청크를 다시 보낸다.
    // 404·409·403 은 녹음이 지워졌거나 서버가 이미 종료한 것이라 이 탭의 녹음을 접는다.
    const pump = async () => {
        if (pumping) return;
        pumping = true;
        while (queue.length) {
            const id = get().id;
            if (!id) break;
            let res: Response | null = null;
            try {
                res = await fetch(`/api/recordings/${id}/chunks`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: queue[0] });
            } catch { /* 네트워크 단절 */ }
            if (res?.ok) { queue.shift(); continue; }
            if (res && (res.status === 404 || res.status === 409 || res.status === 403)) {
                if (recorder && recorder.state !== 'inactive') recorder.stop();
                release();
                break;
            }
            await new Promise(r => setTimeout(r, RETRY_MS));
        }
        pumping = false;
    };
    const drained = () => new Promise<void>(resolve => {
        const tick = () => (queue.length || pumping ? setTimeout(tick, 200) : resolve());
        tick();
    });

    return {
        id: null,
        paused: false,
        start: async title => {
            if (get().id) { alert('이 탭에서 이미 녹음이 진행 중입니다. 먼저 종료해 주세요.'); return null; }
            // 마이크 API 는 보안 컨텍스트(HTTPS 또는 localhost)에서만 있다. IP 로 평문 접속하면 여기서 걸린다
            if (!window.isSecureContext) { alert('마이크는 HTTPS 또는 localhost 로 접속했을 때만 쓸 수 있습니다. https 주소로 다시 열어 주세요.'); return null; }
            if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { alert('이 브라우저에서는 녹음을 지원하지 않습니다.'); return null; }
            try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
            catch (err) {
                // NotAllowedError: 사용자가 거부했거나 사이트·OS 설정에서 막힘. NotFoundError: 장치 없음. NotReadableError: 다른 앱이 점유 중
                const name = err instanceof Error ? err.name : '';
                const hint = name === 'NotAllowedError' ? '주소창 왼쪽 자물쇠(사이트 설정)에서 마이크를 허용하고, OS 의 마이크 접근 권한도 확인해 주세요.'
                    : name === 'NotFoundError' ? '사용할 수 있는 마이크 장치가 없습니다.'
                    : name === 'NotReadableError' ? '다른 프로그램이 마이크를 사용 중입니다.'
                    : (err instanceof Error ? err.message : String(err));
                alert(`녹음을 시작할 수 없습니다 (${name || '오류'}). ${hint}`);
                return null;
            }
            const id = rid(8);
            const now = Date.now();
            if (!recordings.insert({ id, title, status: 'recording', started_at: now, duration_ms: 0, segment_started_at: now })) {
                alert('연결이 끊겨 녹음을 시작할 수 없습니다.');
                release();
                return null;
            }
            const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
            recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: BITRATE });
            recorder.ondataavailable = e => { if (e.data.size) { queue.push(e.data); void pump(); } };
            recorder.start(TIMESLICE_MS);
            audioCtx = new AudioContext();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 1024;
            levelBuf = new Float32Array(analyser.fftSize);
            audioCtx.createMediaStreamSource(stream).connect(analyser);
            segmentStart = now; accumulated = 0;
            heartbeat = setInterval(() => recordings.update({ id, last_chunk_at: Date.now() }), HEARTBEAT_MS);
            window.addEventListener('beforeunload', onBeforeUnload);
            set({ id, paused: false });
            return id;
        },
        pause: () => {
            const id = get().id;
            if (!id || !recorder || recorder.state !== 'recording') return;
            recorder.pause();
            accumulated += Date.now() - segmentStart;
            recordings.update({ id, status: 'paused', duration_ms: accumulated, segment_started_at: null });
            set({ paused: true });
        },
        resume: () => {
            const id = get().id;
            if (!id || !recorder || recorder.state !== 'paused') return;
            recorder.resume();
            segmentStart = Date.now();
            recordings.update({ id, status: 'recording', segment_started_at: segmentStart });
            set({ paused: false });
        },
        // 녹음기를 멈춰 마지막 청크를 받고, 큐가 비면 서버에 종료를 알린다. 서버가 파일을 확정하고 status 를 stopped 로 바꾼다.
        stop: async () => {
            const id = get().id;
            if (!id || !recorder) return;
            if (recorder.state !== 'inactive') {
                await new Promise<void>(resolve => { recorder!.onstop = () => resolve(); recorder!.stop(); });
            }
            stream?.getTracks().forEach(t => t.stop());
            await drained();
            while (get().id === id) {
                try {
                    const res = await fetch(`/api/recordings/${id}/stop`, { method: 'POST' });
                    if (res.ok || res.status === 404 || res.status === 403) break;
                } catch { /* 네트워크 단절 — 다시 시도 */ }
                await new Promise(r => setTimeout(r, RETRY_MS));
            }
            release();
        },
    };
});

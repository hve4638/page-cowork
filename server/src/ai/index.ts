// 어떤 전사·요약 구현체를 쓸지 고르는 자리. 설정(ai.stt.provider·ai.llm.provider)이 이름을 고르고, 나머지 코드는 이 두 함수만 쓴다.
// 새 서비스를 붙일 때는 파일 하나를 만들어 아래 목록에 이름을 더한다. 기본값이 mock 인 이유는 키 없이도 화면이 돌아야 하기 때문이다.
import { ai } from '../config.ts';
import { chatSummarizer } from './chat.ts';
import { mockStt, mockSummarizer } from './mock.ts';
import { speechmaticsStt } from './speechmatics.ts';
import type { Summarizer, SttProvider } from './types.ts';

const STT: Record<string, SttProvider> = { mock: mockStt, speechmatics: speechmaticsStt };
const LLM: Record<string, Summarizer> = { mock: mockSummarizer, chat: chatSummarizer };

function pick<T>(kind: string, table: Record<string, T>, name: string): T {
    const found = table[name];
    if (!found) throw new Error(`알 수 없는 ${kind} 제공자 '${name}' 입니다. 쓸 수 있는 값: ${Object.keys(table).join(', ')}`);
    return found;
}

export const stt = (): SttProvider => pick('전사', STT, ai.stt.provider);
export const summarizer = (): Summarizer => pick('요약', LLM, ai.llm.provider);

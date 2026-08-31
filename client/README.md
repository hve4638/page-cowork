# Frontend Template

React + TypeScript + Vite 기반 프론트엔드 템플릿

## 요구사항

- Node.js >= 20.0.0
- **pnpm >= 9.0.0** (필수)

## 시작하기

```bash
# 의존성 설치
pnpm install

# 개발 서버 실행
pnpm dev

# 빌드
pnpm build

# 린트
pnpm lint
```

## 기술 스택

- React 19
- TypeScript 5.6
- Vite 5
- Zustand 5 (상태 관리)
- Tailwind CSS 4
- SCSS

## 디렉토리 구조

```
src/
├── assets/style/       # 스타일 시스템
│   ├── theme/          # 다크/라이트 테마
│   ├── flexstyle/      # Flexbox 유틸리티
│   └── module/         # Reset, 폰트
├── components/         # 재사용 컴포넌트
│   ├── atoms/          # 기본 UI (Button, Input, Spinner)
│   └── layout/         # 레이아웃 컴포넌트
├── features/           # 기능 모듈
│   └── modal/          # 모달 시스템
├── hooks/              # 커스텀 훅
├── lib/                # 내부 라이브러리
│   └── zustbus/        # 이벤트 버스
├── stores/             # Zustand 스토어
├── types/              # TypeScript 타입
├── constants/          # 상수
└── utils/              # 유틸리티 함수
```

## 주요 기능

### 테마 시스템

```tsx
// 테마 클래스 적용
<div className="theme-dark">
  {/* 다크 테마 적용 */}
</div>
```

CSS 변수로 색상 접근:
- `--text-color`: 기본 텍스트
- `--bgcolor`: 배경색
- `--text-color-dim`: 흐린 텍스트

### 상태 관리 (Zustand)

```tsx
import { useAppStore, useConfigStore } from '@/stores';

// 앱 상태
const { theme, toggleTheme } = useAppStore();

// 설정 (localStorage 영속화)
const { fontSize, setFontSize } = useConfigStore();
```

### 모달 시스템

```tsx
import { useModal, Modal } from '@/features/modal';

function MyComponent() {
  const { open } = useModal();

  const openModal = () => {
    open(
      <Modal header={<h2>Title</h2>}>
        <p>Modal content</p>
      </Modal>
    );
  };
}
```

### 커스텀 훅

```tsx
import {
  useDebounce,
  useThrottle,
  useCache,
  useStorage,
  useRerender,
} from '@/hooks';

// 디바운스
const debouncedSearch = useDebounce(search, 300);

// 쓰로틀
const throttledScroll = useThrottle(onScroll, 100);

// LRU 캐시
const cachedValue = useCache(() => compute(id), [id], 10);
```

### 이벤트 버스 (Zustbus)

```tsx
import { createBus } from '@/lib/zustbus';

// 전역 버스 생성
type Events = {
  refresh: undefined;
  update: { id: string };
};

const [emit, useOn, useValue] = createBus<Events>();

// 이벤트 발행
emit('refresh');
emit('update', { id: '123' });

// 이벤트 구독
useOn('refresh', () => {
  console.log('Refreshed');
});
```

## 컴포넌트

### Button

```tsx
import { Button } from '@/components';

<Button onClick={handleClick}>Click me</Button>
<Button variant="green">Success</Button>
<Button variant="red" disabled>Disabled</Button>
```

### Input

```tsx
import { Input } from '@/components';

<Input
  value={value}
  onChange={setValue}
  placeholder="Enter text..."
/>
```

### Spinner

```tsx
import { Spinner } from '@/components';

<Spinner size={32} color="#7983ff" />
```

## 경로 별칭

tsconfig.app.json에 정의:

```typescript
import { Button } from '@/components';
import { useAppStore } from 'stores';
import { useDebounce } from 'hooks';
```

## 문서

- `docs/CONVENTIONS.md` - 코딩 컨벤션
- `docs/ARCHITECTURE.md` - 아키텍처 가이드
- `docs/PATTERNS.md` - 디자인 패턴

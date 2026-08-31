# Coding Conventions

프로젝트 코딩 컨벤션 및 규칙 문서. AI 에이전트와 기여자가 일관성을 유지하기 위한 가이드.

## 1. 네이밍 규칙

### 파일명
| 유형 | 규칙 | 예시 |
|------|------|------|
| 컴포넌트 | PascalCase | `Button.tsx`, `SessionPanel.tsx` |
| 훅 | camelCase + use 접두사 | `useCache.ts`, `useDebounce.ts` |
| 유틸리티 | camelCase | `formatDate.ts`, `parseQuery.ts` |
| 타입 정의 | kebab-case 또는 camelCase | `common-props.ts`, `types.ts` |
| 스타일 | 컴포넌트명.module.scss | `Button.module.scss` |

### 코드 내 네이밍
| 유형 | 규칙 | 예시 |
|------|------|------|
| 컴포넌트 | PascalCase | `SessionPanel`, `ModalBox` |
| 타입/인터페이스 | PascalCase | `ProfileData`, `ButtonProps` |
| 함수/훅 | camelCase | `useCache`, `formatDate` |
| 변수 | camelCase | `isLoading`, `userData` |
| 상수 | UPPER_SNAKE_CASE | `Z_INDEX`, `API_URL` |

## 2. Enum 대체 패턴

TypeScript `enum` 대신 `const` 객체 + `typeof` 패턴 사용:

```typescript
// ✅ 권장
const LoadPhase = {
    Boot: 'boot',
    Ready: 'ready',
    Error: 'error',
} as const;
type LoadPhase = typeof LoadPhase[keyof typeof LoadPhase];

// ❌ 비권장
enum LoadPhase {
    Boot = 'boot',
    Ready = 'ready',
}
```

**장점:**
- 트리 셰이킹 가능
- 런타임 오버헤드 없음
- 객체로서 순회 가능

## 3. Private 필드

클래스 기반 서비스에서는 `#` private 필드 사용:

```typescript
class AuthService {
    #token: string | null = null;
    #refreshToken: string | null = null;

    get isAuthenticated() {
        return this.#token !== null;
    }

    setToken(token: string) {
        this.#token = token;
    }
}
```

## 4. Import 규칙

### 순서
1. Third-party 패키지
2. Type imports (`import type`)
3. Internal (`@/`)
4. Relative (`./`)

```typescript
// 1. Third-party
import { useState, useEffect } from 'react';
import classNames from 'classnames';

// 2. Type imports
import type { ButtonProps } from '@/types';

// 3. Internal (절대 경로)
import { useAppStore } from '@/stores';
import { Button } from '@/components';

// 4. Relative (상대 경로)
import { helper } from './utils';
import styles from './styles.module.scss';
```

### 경로 규칙
- **디렉토리 간 import**: 항상 `@/` 별칭 사용
- **같은 feature/directory 내**: 상대 경로 사용 가능
- **Barrel imports**: 가능하면 `index.ts`에서 import

```typescript
// ✅ 권장
import { Button, Input } from '@/components';
import { useModal } from '@/features/modal';

// ❌ 비권장 (deep import)
import Button from '@/components/atoms/Button/Button';
```

## 5. Barrel Exports

각 디렉토리는 `index.ts`로 public API를 재내보내기:

```typescript
// components/atoms/index.ts
export { default as Button } from './Button';
export type { ButtonProps } from './Button';

export { default as Input } from './Input';
export type { InputProps } from './Input';

export { Spinner } from './Spinner';
```

## 6. Props 정의

### 기본 구조
```typescript
import { CommonProps, MouseActionProps } from '@/types';

interface ButtonProps extends CommonProps, MouseActionProps<HTMLButtonElement> {
    children?: React.ReactNode;
    disabled?: boolean;
    variant?: 'default' | 'primary' | 'danger';
}
```

### 재사용 가능한 Props 인터페이스
- `CommonProps` - className, style
- `MouseActionProps<T>` - onClick, onMouseEnter 등
- `KeyboardActionProps<T>` - onKeyDown, onKeyUp
- `FocusActionProps<T>` - onFocus, onBlur
- `DragActionProps<T>` - onDragStart, onDrop 등

## 7. 컴포넌트 구조

### 폴더 구조
```
ComponentName/
├── ComponentName.tsx      # 컴포넌트 구현
├── ComponentName.module.scss  # 스타일 (선택)
├── index.ts              # 재내보내기
└── types.ts              # 타입 (복잡한 경우)
```

### 컴포넌트 템플릿
```typescript
import classNames from 'classnames';
import { CommonProps } from '@/types';
import styles from './ComponentName.module.scss';

interface ComponentNameProps extends CommonProps {
    // props 정의
}

function ComponentName({
    className,
    style,
    // ...props
}: ComponentNameProps) {
    return (
        <div
            className={classNames(styles['container'], className)}
            style={style}
        >
            {/* content */}
        </div>
    );
}

export default ComponentName;
```

## 8. 훅 규칙

### 네이밍
- 모든 훅은 `use` 접두사
- 명확한 목적 표현: `useDebounce`, `useThrottle`, `useCache`

### 분류
| 위치 | 용도 | 예시 |
|------|------|------|
| `hooks/` | 범용 유틸리티 훅 | `useDebounce`, `useCache` |
| `hooks/context/` | Context 접근 훅 | `useAuth`, `useTheme` |
| `features/[name]/hooks/` | Feature 전용 훅 | `useModalInstance` |

### 제네릭 훅
```typescript
function useCache<T>(
    factory: () => T,
    deps: DependencyList,
    maxCache: number = 10
): T {
    // ...
}
```

## 9. TypeScript 설정

- **Strict mode**: 활성화
- **noImplicitAny**: false (허용)
- **noPropertyAccessFromIndexSignature**: true (인덱스 시그니처 접근 시 `['key']` 사용)

```typescript
// noPropertyAccessFromIndexSignature: true 인 경우
import styles from './styles.module.scss';

// ✅ 권장
className={styles['container']}

// ❌ 에러
className={styles.container}
```

## 10. 주석 규칙

### 필요한 경우만 작성
- 복잡한 비즈니스 로직
- 비자명한 알고리즘
- 임시 해결책 (TODO, FIXME)

### JSDoc
공개 API, 유틸리티 함수, 훅에 사용:

```typescript
/**
 * LRU 캐시 기반 메모이제이션 훅
 * @param factory - 값 생성 함수
 * @param deps - 의존성 배열
 * @param maxCache - 최대 캐시 크기 (기본: 10)
 */
function useCache<T>(
    factory: () => T,
    deps: DependencyList,
    maxCache: number = 10
): T
```

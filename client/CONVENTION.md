# Project Conventions

This document describes the coding conventions, architecture patterns, and rules for the project. It is intended for AI agents and contributors to maintain consistency.

## 1. Coding Conventions

- **Component & type naming**: PascalCase (`SessionPanel`, `ProfileData`)
- **Function, hook & variable naming**: camelCase (`useCache`, `formatDate`, `isLoading`)
- **Component file naming**: PascalCase (`Button.tsx`, `SessionPanel.tsx`)
- **Utility & hook file naming**: camelCase (`useCache.ts`, `formatDate.ts`)
- **Barrel exports**: Each directory exposes an `index.ts` re-exporting its public API
- **Enum-like constants**: Use a `const` object + `typeof` pattern instead of TypeScript `enum`
  ```ts
  const LoadPhase = { Boot: 'boot', Ready: 'ready' } as const;
  type LoadPhase = typeof LoadPhase[keyof typeof LoadPhase];
  ```
- **Private fields**: Use `#` private fields in class-based services
- **TypeScript strict mode**: Enabled. `noImplicitAny: false` is allowed per `tsconfig.app.json`
- **String quotes**: Use single quotes (`'`) instead of double quotes (`"`)

## 2. Directory Structure

```
src/
  api/            — API/service layer
  assets/         — Static assets and SCSS styles
  components/     — Reusable UI components
    atoms/          — Primitive elements (Button, CheckBox, Input, Dropdown, Slider)
    container/      — Container-level components
    layout/         — Layout components (Row, Column, Grid, Flex, Center, Gap)
    ui/             — General UI components
  constants/      — App-wide constants
  context/        — React Context providers
  events/         — Event definitions
  features/       — Feature modules
  hooks/          — Custom hooks
    context/        — Context-access hooks
  lib/            — Third-party wrappers
  locales/        — i18n translation files
  modals/         — Top-level modal components
  pages/          — Page-level route components
  stores/         — Zustand stores
  types/          — TypeScript type definitions
  utils/          — Utility functions
```

### Component File Structure

```
ComponentName/
├── index.ts                   # export and style import
├── ComponentName.tsx          # Main component
├── ComponentName.module.scss  # Styles
├── types.ts                   # Types (if needed)
└── utils.ts                   # Utilities (if needed)
```

### Page Structure

```
PageName/
├── index.ts         # export
├── PageName.tsx     # Main page
├── layout/          # Page-internal layout
└── hooks/           # Page-specific hooks
```

## 3. Architecture Patterns

- **React Context for feature-scoped state**: Use React Context for localized state where it fits.
- **API facade**: Higher-level APIs delegate to lower-level ones.
- **Feature-based modules**: Self-contained feature directories under `features/` with their own components, hooks, and logic.

## 4. Import Rules

1. **Order**: third-party → type imports → internal (`@/`) → relative (`./`)
2. **Cross-directory imports**: Always use the `@/` alias (e.g., `import { X } from '@/stores'`)
3. **Relative imports**: Only for sibling or child files within the same feature/directory
4. **Type-only imports**: Use the `type` keyword (`import type { Foo } from '...'`)
5. **Barrel imports**: Import from `index.ts` barrels where available rather than deep paths

## 5. Alias Rules

- Use `@/*` to access `src/*`.

## 6. Component Rules

- **Atomic Design hierarchy**: `atoms/` → `container/` → `layout/` → feature-level components
- **Props**: Define as explicit TypeScript interfaces
- **Named exports only**. Default exports are not allowed.
- **Barrel-first imports**: If a directory provides `index.ts`, import from that barrel.
- **No deep imports**: Only import from file paths when no barrel is available.
- **Styling**: Create `ComponentName.module.scss` for component styles. Reference `@/assets/style/` for style utilities.
- **Conditional classes**: Use the `classnames` library for conditional class composition.
- **No native HTML elements**: Do not use native `<button>`, `<input>`, etc. Use custom components instead:
  - Button: `@/components/atoms/Button`
  - CheckBox: `@/components/atoms/CheckBox`
  - Input: `@/components/atoms/Input`
  - Dropdown: `@/components/atoms/Dropdown`
  - Slider: `@/components/atoms/Slider`
- **Layout components**: Use layout components from `@/components/layout` (Row, Column, Grid, Flex, Center, Gap)

## 7. Hook Rules

- **Naming**: All hooks use the `use[Name]` prefix
- **Context hooks** (`hooks/context/`): Access shared state
- **Utility hooks** (`hooks/` root): Reusable logic
- **Feature hooks**: Co-located inside `features/[name]/hooks/`
- **Generics**: Use generic typing for reusable hooks (e.g., `useCache<T>`)

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // 좌석 스폰 테스트는 실제 프로세스를 띄우므로 기본 타임아웃을 넉넉히 둔다
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

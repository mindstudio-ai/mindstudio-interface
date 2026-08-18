import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/voice.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  minify: true,
  // Load-bearing with two entries: splitting hoists shared modules
  // (config.ts, errors.ts, telemetry) into one chunk, so an app importing
  // both `.` and `./voice` gets ONE bootstrap-config cache and ONE telemetry
  // install. Disabling it would duplicate that module state per entry.
  splitting: true,
});

#!/usr/bin/env node
/**
 * Validates PACE's FIT, GPX/TCX and archive import against the athlete's own exports kept
 * OUTSIDE the repository. The implementation is the `@pace/import-validation` package
 * (packages/import-validation); see docs/TESTING.md, "FIT validation with real device files".
 *
 *   pnpm validate:fit <folder> [--manifest <file>] [--out <folder>] [--expect-valid] [--write-key]
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runCli } = require('../packages/import-validation/dist/index.js');

process.exitCode = await runCli(process.argv.slice(2));

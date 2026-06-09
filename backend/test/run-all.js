/**
 * Run every backend sanity-test suite in sequence, fail on first error.
 *
 * Each suite manages its own embedded-PG harness so we can't share the
 * cluster, but running them serially still completes in well under a
 * minute on the local laptop.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  'schema.test.js',
  'skill.test.js',
  'elo.test.js',
  'builder.test.js',
  'routes.test.js',
  'export.test.js',
  'import.test.js',
  'tokens.test.js',
];

async function runOne(name) {
  return new Promise((resolve, reject) => {
    console.log(`\n========== ${name} ==========`);
    const p = spawn(process.execPath, [path.join(__dirname, name)], {
      stdio: 'inherit',
      env: process.env,
    });
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)));
  });
}

(async () => {
  for (const s of SUITES) {
    await runOne(s);
  }
  console.log('\nAll suites passed.');
})().catch(e => {
  console.error('\nSUITE FAILED:', e.message);
  process.exit(1);
});

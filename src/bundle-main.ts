/**
 * Entrypoint for the single-file bundle (`npm run bundle`).
 *
 * WHY THIS EXISTS
 * ---------------
 * The bundle was originally built from `src/main.ts` alone. `main.ts` imports
 * neither `doctor.ts` nor `login.ts`, so the artefact shipped with:
 *
 *   - no `doctor` at all — the exact gap #146 was opened to fix for Docker,
 *     reintroduced in a new distribution path, and
 *   - no standalone `login`, only the implicit login `main` falls into when no
 *     token exists.
 *
 * The reason it cannot just include them and rely on their own entry guards is
 * that `isMainModule` compares `process.argv[1]` with `import.meta.url`. In a
 * bundle those are the SAME file, so the guard is true for every bundled module
 * at once and cannot select one. Hence explicit subcommands here, with the CLI
 * bodies extracted into callable functions.
 *
 * SETTING `process.argv[1]` GIVES THE DAEMON ITS BEHAVIOUR
 * -------------------------------------------------------
 * `main.ts` is imported for its side effects and its own guard looks at
 * `argv[1]`. Setting `argv[1]` to the bundle's own path makes that guard pass,
 * so `node bundle.mjs` (no subcommand) keeps meaning "run the bridge", which is
 * what an operator replacing `node dist/main.js` expects. It is set BEFORE the
 * import for that reason — a static import would be hoisted above it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);

const USAGE = `carelink-bridge

Usage:
  carelink-bridge                run the bridge (the daemon)
  carelink-bridge doctor         pre-flight self-check
  carelink-bridge login          interactive CareLink login
  carelink-bridge --help

Environment: CARELINK_USERNAME, CARELINK_PASSWORD, API_SECRET, NS
See deploy/README.md, or https://github.com/NovaLux12/carelink-bridge
`;

async function main(argv: string[]): Promise<number> {
  const sub = argv[0];

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (sub === 'doctor') {
    await loadEnv();
    const { doctorCli } = await import('./doctor.js');
    return doctorCli();
  }

  if (sub === 'login') {
    await loadEnv();
    const { loginCli } = await import('./login.js');
    return loginCli();
  }

  if (sub !== undefined) {
    process.stderr.write(`unknown command: ${sub}\n\n${USAGE}`);
    return 2;
  }

  // No subcommand: behave as the daemon. `main.ts` is self-executing and calls
  // `dotenv.config()` itself, so loading the env here too would print the
  // "injected env" banner twice. Set `process.argv[1]` so main's own
  // `isMainModule` guard passes, then import for its side effects.
  process.argv[1] = selfPath;
  await import('./main.js');
  return 0;
}

/** Load `.env` once, for the subcommands that need it before doing any work. */
async function loadEnv(): Promise<void> {
  const dotenv = await import('dotenv');
  dotenv.config();
}

main(process.argv.slice(2))
  .then(code => process.exit(code))
  .catch(err => {
    process.stderr.write(`${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  });

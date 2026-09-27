#!/usr/bin/env node
// Run the README's "Getting started" steps as written, then check they reach a
// cited answer (#152). CI runs this on the release PR; see docs/ci-cd.md.
//
//   node scripts/quickstart.mjs            # in CI, or a fresh clone
//   node scripts/quickstart.mjs --print    # show the commands it would run
//
// The commands come from README.md itself, so the README and this check
// cannot drift apart. Two steps are made non-interactive, and nothing else is
// rewritten:
// - `npx auth secret` prompts, so a random AUTH_SECRET is written instead;
// - `pnpm dev` becomes `pnpm build`; Playwright then starts `pnpm start`.
// The README's "set LLM_API_KEY" step points .env at the stub model server
// (tests/stub-llm), so no real key is needed. Then tests/e2e/quickstart.spec.ts
// follows the README's browser steps.
import { execSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const STUB_PORT = 4010

/** The commands in the README's first bash block under "## Getting started". */
export function quickstartSteps(readme) {
  const section = readme.split(/^## Getting started\s*$/m)[1]
  const block = section?.match(/```bash\n([\s\S]*?)```/)?.[1]
  if (!block)
    throw new Error('README has no bash block under "## Getting started".')
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line.startsWith('#')
        ? { comment: line }
        : { command: line.replace(/\s+#.*$/, '') },
    )
}

const steps = quickstartSteps(readFileSync(join(root, 'README.md'), 'utf8'))

if (process.argv.includes('--print')) {
  for (const s of steps) console.log(s.command ?? s.comment)
  process.exit(0)
}

// `cp .env.example .env` would overwrite a developer's own settings.
if (!process.env.CI && existsSync(join(root, '.env'))) {
  console.error(
    'quickstart: refusing to run over an existing .env outside CI. Use a fresh clone.',
  )
  process.exit(1)
}

const run = (command) => {
  console.log(`\n$ ${command}`)
  execSync(command, { cwd: root, stdio: 'inherit' })
}

let keyStep = false
let devStep = false
for (const step of steps) {
  if (step.comment) {
    // "# then set LLM_API_KEY in .env" — here, the stub model server.
    if (/LLM_API_KEY/.test(step.comment)) {
      keyStep = true
      appendFileSync(
        join(root, '.env'),
        `\n# quickstart check: the stub model server\nLLM_API_KEY=stub\nRAG_LLM_BASE_URL=http://127.0.0.1:${STUB_PORT}/v1\n`,
      )
      console.log('\n# LLM_API_KEY → the stub model server')
    }
    continue
  }
  if (step.command === 'npx auth secret') {
    appendFileSync(
      join(root, '.env'),
      `\nAUTH_SECRET="${randomBytes(33).toString('base64')}"\n`,
    )
    console.log('\n# npx auth secret → a random AUTH_SECRET')
    continue
  }
  if (step.command === 'pnpm dev') {
    devStep = true
    run('pnpm build')
    continue
  }
  run(step.command)
}

// If the README drops or renames either step, this check must say so rather
// than quietly test something else.
if (!keyStep) throw new Error('README no longer says where to set LLM_API_KEY.')
if (!devStep) throw new Error('README no longer ends with `pnpm dev`.')

const stub = spawn(
  process.execPath,
  [join(root, 'tests/stub-llm/server.mjs'), String(STUB_PORT)],
  {
    stdio: 'inherit',
  },
)
try {
  if (process.env.CI) run('pnpm exec playwright install --with-deps chromium')
  run(
    'pnpm exec playwright test tests/e2e/quickstart.spec.ts --project=chromium',
  )
} finally {
  stub.kill()
}

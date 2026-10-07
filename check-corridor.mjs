// Sanity check for the corridor derivations, run against the real simulation.
//
// Every quantity the corridor draws has to survive contact with actual data:
// a NaN in the covariance reaches the shader and the layer silently disappears,
// which is exactly the kind of bug a type checker cannot see. Each check below
// asserts a property the visualisation depends on.
//
//   node check-corridor.mjs
//
// Bundled with the project's own bundler, so it adds no dependency.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = resolve(new URL('.', import.meta.url).pathname.replace(/^\//, ''))
const { build } = await import(
  pathToFileURL(join(projectRoot, 'node_modules/rolldown/dist/index.mjs')).href
)

const work = mkdtempSync(join(tmpdir(), 'corridor-'))
const entry = join(work, 'check.ts')
const out = join(work, 'check.mjs')

writeFileSync(
  entry,
  `import { run } from ${JSON.stringify(join(projectRoot, 'check-corridor.ts').replace(/\\/g, '/'))}
run().then((code) => process.exit(code))
`,
)

await build({ input: entry, platform: 'node', output: { file: out, format: 'esm' } })

const result = spawnSync(process.execPath, [out], { stdio: 'inherit' })
rmSync(work, { recursive: true, force: true })
process.exit(result.status ?? 1)
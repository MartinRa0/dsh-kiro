/** Verify the packed plugin against a real DSH launcher without exemptions. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../', import.meta.url))
const cli = process.argv[2] ?? process.env.DSH_CLI
assert(cli, 'Usage: npm run test:dsh -- /absolute/path/to/@deepseek-ai/dsh/lib/bin.js')
const launcher = resolve(cli)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const target = manifest.peerDependencies['@deepseek-ai/dsh-llm']
const temporary = mkdtempSync(join(tmpdir(), 'dsh-kiro-native-'))
const dshHome = join(temporary, 'dsh-home')
const isolatedHome = join(temporary, 'user-home')
mkdirSync(isolatedHome)
const env = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }
const runtimeEnv = { ...env, HOME: isolatedHome }
for (const key of Object.keys(runtimeEnv)) {
  if (key.startsWith('KIRO_')) delete runtimeEnv[key]
}
const redact = (text) => text.replace(/([?&]token=)[^\s]+/gu, '$1[redacted]')

function run(command, args, environment = env, allowedStatuses = [0]) {
  const result = spawnSync(command, args, {
    cwd: root, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || !allowedStatuses.includes(result.status)) {
    throw new Error(redact(`${command} failed: ${result.error ?? ''}\n${result.stderr}\n${result.stdout.slice(-1500)}`))
  }
  assert(!/disabling profile plugin row/u.test(result.stderr), redact(result.stderr))
  return result.stdout
}

function assertNoExemptions() {
  const path = join(dshHome, 'profiles/web/compatibility.json')
  assert(!existsSync(path) || Object.keys(JSON.parse(readFileSync(path, 'utf8'))).length === 0,
    'The smoke profile must contain no version exemptions')
}

let service
let output = ''
let success = false
try {
  assert.equal(run(process.execPath, [launcher, '--version']).trim(), target)
  const packs = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]))
  const packed = Array.isArray(packs) ? packs[0] : packs[manifest.name]
  assert(packed?.filename, 'npm pack did not report the plugin archive')
  run(process.execPath, [launcher, 'plugin', '--profile', 'web', 'add', join(temporary, packed.filename)])
  const installed = JSON.parse(readFileSync(join(dshHome, 'profiles/web/node_modules/dsh-kiro/package.json'), 'utf8'))
  assert.equal(installed.version, manifest.version)
  assertNoExemptions()
  console.log(`Packed dsh-kiro ${installed.version}: installed on DSH ${target} without exemptions`)

  const schema = JSON.parse(run(process.execPath, [launcher, '--profile', 'web', '--dump-config-schema'], runtimeEnv, [0, 1]))
  const collection = schema['x-cordis']
  const kiro = collection.entries.find((entry) => entry.name === 'dsh-kiro')
  assert.equal(kiro?.status, 'schema', 'The native loader must import and project the Kiro config')
  // DSH 0.2.1-rc.2 cannot project its own agent-preset carriers. Permit only
  // that exact upstream diagnostic; unexpected errors still fail this check.
  const errors = collection.diagnostics.filter((entry) => entry.level === 'error')
  for (const error of errors) {
    const entry = collection.entries.find((entry) => entry.path === error.path)
    assert.equal(entry?.name, '@deepseek-ai/dsh-agent-preset', JSON.stringify(error))
    assert.equal(error.message, 'unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection')
  }
  console.log(`Native Kiro import and config schema: OK (${errors.length} upstream preset projection limitations)`)

  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
  service = spawn(process.execPath, [launcher, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: root, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  service.stdout.on('data', (chunk) => { output += chunk })
  service.stderr.on('data', (chunk) => { output += chunk })
  let loginUrl
  for (let attempt = 0; attempt < 150; attempt += 1) {
    loginUrl = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/u)?.[1]
    if (loginUrl || service.exitCode !== null) break
    await delay(200)
  }
  assert(loginUrl, `Web server did not become ready:\n${redact(output)}`)
  assert(!/disabling profile plugin row/u.test(output), redact(output))
  const login = await fetch(loginUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  assert([302, 303, 307].includes(login.status), `Unexpected login response: ${login.status}`)
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  assert(cookie, 'The web server did not issue a login cookie')
  for (const path of ['/', '/kiro/api/status']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { cookie }, signal: AbortSignal.timeout(10_000),
    })
    assert.equal(response.status, 200, `${path}: HTTP ${response.status}`)
    if (path.endsWith('/status')) assert.equal((await response.json()).ok, true)
    else await response.arrayBuffer()
  }
  assertNoExemptions()
  console.log('Web startup, authenticated page, and Kiro settings API: HTTP 200')
  success = true
} finally {
  if (service && service.exitCode === null) {
    service.kill('SIGTERM')
    const forced = setTimeout(() => service.kill('SIGKILL'), 10_000)
    try { await once(service, 'exit') } finally { clearTimeout(forced) }
  }
  if (success) rmSync(temporary, { recursive: true, force: true })
  else {
    writeFileSync(join(temporary, 'startup.log'), redact(output), { mode: 0o600 })
    console.error(`Failure diagnostics: ${temporary}`)
  }
}

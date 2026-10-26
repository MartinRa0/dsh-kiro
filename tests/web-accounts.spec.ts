import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as login from '../src/login.ts'
import { KiroAccountStore } from '../src/accounts.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { saveManagedCredentials } from '../src/login.ts'
import { FileModelSettingsStore } from '../src/model-settings.ts'
import { registerWebApi } from '../src/web.ts'
import type { WebDependencies } from '../src/web.ts'

let home: string
let directory: string
let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
let dispose: () => void

/** Drive one request through the registered Kiro API handler. */
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; value: any }> {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
  let status = 0
  let payload = ''
  const response = {
    writeHead: (code: number) => { status = code },
    end: (value: string) => { payload = value },
  } as unknown as ServerResponse
  await handler(request, response)
  return { status, value: payload.length === 0 ? undefined : JSON.parse(payload) }
}

/** One credential record shaped like a stored account credential. */
function credential(accessToken: string, clientIdHash?: string): Record<string, unknown> {
  return {
    accessToken,
    refreshToken: accessToken + '-refresh',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    region: 'us-east-1',
    authMethod: 'builder-id',
    ...clientIdHash === undefined ? {} : { clientIdHash },
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-kiro-web-'))
  process.env.DSH_HOME = home
  directory = join(home, 'storages', 'kiro-auth')
  const ctx = {
    emit: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
    inject: (_names: string[], use: (scope: unknown) => void) => {
      use({
        effect: (run: () => () => void) => { dispose = run() },
        webServer: {
          register: (options: { handler: typeof handler }) => {
            handler = options.handler
            return () => undefined
          },
        },
      })
    },
  }
  const dependencies = {
    managedDirectory: directory,
    options: () => resolveAdapterOptions({ region: 'us-east-1' }),
    discovery: { current: () => undefined, clear: () => undefined, list: async () => [] },
    modelSettings: new FileModelSettingsStore(),
    usage: { current: () => undefined, clear: () => undefined, get: async () => ({}) },
    resolveToken: async () => { throw new Error('not used by these routes') },
  } as unknown as WebDependencies
  registerWebApi(ctx as never, dependencies)
})

afterEach(async () => {
  dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

describe('Kiro device login API', () => {
  const session: login.DeviceLoginSession = {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    deviceCode: 'private-device-code',
    userCode: 'TEST-CODE',
    verificationUri: 'https://example.invalid/device',
    intervalSeconds: 5,
    expiresAt: Date.now() + 600_000,
    region: 'us-east-1',
    authMethod: 'builder-id',
    startUrl: 'https://view.awsapps.com/start',
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(login, 'startDeviceLogin').mockResolvedValue(session)
    vi.spyOn(login, 'pollDeviceLogin').mockResolvedValue({ status: 'pending', intervalSeconds: 5 })
    // Status must not inspect credentials outside this test's temporary home.
    vi.spyOn(login, 'credentialSummary').mockResolvedValue({ authenticated: false })
  })

  it.each(['builder-id', 'idc'])('publishes the pending %s flow in login and status responses', async method => {
    const result = await call('POST', '/kiro/api/login', {
      method,
      startUrl: 'https://company.awsapps.com/start',
      accountId: 'existing-account',
    })
    expect(result.status).toBe(200)
    expect(result.value.value).toEqual({
      status: 'pending',
      kind: 'device',
      method,
      authUrl: session.verificationUri,
      userCode: session.userCode,
      accountId: 'existing-account',
      startedAt: expect.any(Number),
    })
    expect(login.startDeviceLogin).toHaveBeenCalledWith(
      'us-east-1', expect.any(Function), expect.any(AbortSignal),
      method === 'idc'
        ? { authMethod: method, startUrl: 'https://company.awsapps.com/start' }
        : { authMethod: method },
    )
    const status = await call('GET', '/kiro/api/status')
    expect(status.value.value.login).toEqual(result.value.value)
    expect(login.pollDeviceLogin).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(login.pollDeviceLogin).toHaveBeenCalledTimes(1)
    expect((await call('GET', '/kiro/api/status')).value.value.login.status).toBe('pending')
  })

  it('replaces an existing pending flow and cancels its polling', async () => {
    await call('POST', '/kiro/api/login', { method: 'builder-id' })
    const previousSignal = vi.mocked(login.startDeviceLogin).mock.calls[0]![2]
    vi.mocked(login.startDeviceLogin).mockResolvedValueOnce({ ...session, userCode: 'NEXT-CODE' })
    const next = await call('POST', '/kiro/api/login', { method: 'builder-id' })
    expect(previousSignal.aborted).toBe(true)
    expect(next.value.value).toMatchObject({ status: 'pending', userCode: 'NEXT-CODE' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(login.pollDeviceLogin).toHaveBeenCalledTimes(1)
    expect((await call('GET', '/kiro/api/status')).value.value.login).toEqual(next.value.value)
  })

  it('clears pending authorization and stops polling when cancelled', async () => {
    await call('POST', '/kiro/api/login', { method: 'builder-id' })
    const result = await call('POST', '/kiro/api/login/cancel')
    expect(result.value.value.login).toEqual({ status: 'idle' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(login.pollDeviceLogin).not.toHaveBeenCalled()
  })

  it('reports startup failure without publishing a pending flow', async () => {
    vi.mocked(login.startDeviceLogin).mockRejectedValueOnce(new Error('OIDC unavailable'))
    const result = await call('POST', '/kiro/api/login', { method: 'builder-id' })
    expect(result.status).toBe(500)
    expect(result.value).toEqual({ ok: false, error: 'OIDC unavailable' })
    expect((await call('GET', '/kiro/api/status')).value.value.login).toEqual({ status: 'idle' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(login.pollDeviceLogin).not.toHaveBeenCalled()
  })
})

describe('Kiro account API', () => {
  it('lists no accounts before anything is stored', async () => {
    const result = await call('GET', '/kiro/api/accounts')
    expect(result.status).toBe(200)
    expect(result.value.value).toMatchObject({ activeAccountId: null, accounts: [] })
  })

  it('reports every stored account through status', async () => {
    const store = new KiroAccountStore(directory)
    const first = await store.upsert({ credential: credential('one') })
    await store.upsert({ credential: credential('two'), authMethod: 'google' })
    const result = await call('GET', '/kiro/api/status')
    expect(result.status).toBe(200)
    expect(result.value.value.accounts.accounts).toHaveLength(2)
    expect(result.value.value.activeAccountId).toBe(first.accountId)
  })

  it('switches the active account and mirrors it into the legacy file', async () => {
    const store = new KiroAccountStore(directory)
    await store.upsert({ credential: credential('one') })
    const second = await store.upsert({ credential: credential('two'), authMethod: 'google' })
    const result = await call('POST', '/kiro/api/accounts/activate', { accountId: second.accountId })
    expect(result.status).toBe(200)
    expect(result.value.value.activeAccountId).toBe(second.accountId)
    const mirror = JSON.parse(await readFile(join(directory, 'kiro-auth-token.json'), 'utf8'))
    expect(mirror.accessToken).toBe('two')
  })

  it('refuses to switch to an account that is not stored', async () => {
    const result = await call('POST', '/kiro/api/accounts/activate', { accountId: 'missing' })
    expect(result.status).toBe(500)
    expect(result.value.error).toContain('not stored')
  })

  it('requires a revision field to be a non-negative integer', async () => {
    const store = new KiroAccountStore(directory)
    const added = await store.upsert({ credential: credential('one') })
    const result = await call('POST', '/kiro/api/accounts/activate', { accountId: added.accountId, revision: 'two' })
    expect(result.status).toBe(500)
    expect(result.value.error).toContain('revision')
  })

  it('requires a replacement to remove the active account', async () => {
    const store = new KiroAccountStore(directory)
    const first = await store.upsert({ credential: credential('one') })
    const second = await store.upsert({ credential: credential('two'), authMethod: 'google' })
    const refused = await call('POST', '/kiro/api/accounts/remove', { accountId: first.accountId })
    expect(refused.status).toBe(500)
    expect(refused.value.error).toContain('replacement')
    const removed = await call('POST', '/kiro/api/accounts/remove', {
      accountId: first.accountId,
      replacementId: second.accountId,
    })
    expect(removed.status).toBe(200)
    expect(removed.value.value.activeAccountId).toBe(second.accountId)
    expect(removed.value.value.accounts.accounts.map((account: { id: string }) => account.id))
      .toEqual([second.accountId])
  })


  it('selects the account a login added and leaves a re-login alone', async () => {
    const store = new KiroAccountStore(directory)
    const first = await store.upsert({ credential: credential('one') })
    const second = await store.upsert({ credential: credential('two'), authMethod: 'google' })
    // Adding through the login path activates the credential just entered...
    const added = await saveManagedCredentials(directory, {
      accessToken: 'three',
      refreshToken: 'three-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      region: 'us-east-1',
      authMethod: 'google',
    })
    expect((await store.snapshot()).activeAccountId).toBe(added.accountId)
    // ...while re-authenticating a named account does not move the selection.
    await saveManagedCredentials(directory, {
      accessToken: 'one-again',
      refreshToken: 'one-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      region: 'us-east-1',
      authMethod: 'builder-id',
    }, { accountId: first.accountId })
    const snapshot = await store.snapshot()
    expect(snapshot.activeAccountId).toBe(added.accountId)
    expect(snapshot.accounts.map((account: { id: string }) => account.id).sort())
      .toEqual([first.accountId, second.accountId, added.accountId].sort())
  })

  it('deletes the device registration of the account it removes', async () => {
    const hash = 'a'.repeat(64)
    const store = new KiroAccountStore(directory)
    const first = await store.upsert({ credential: credential('one', hash) })
    const second = await store.upsert({ credential: credential('two'), authMethod: 'google' })
    await writeFile(join(directory, hash + '.json'), JSON.stringify({ clientId: 'c', clientSecret: 's' }), { mode: 0o600 })
    const result = await call('POST', '/kiro/api/accounts/remove', {
      accountId: first.accountId,
      replacementId: second.accountId,
    })
    expect(result.status).toBe(200)
    await expect(stat(join(directory, hash + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves the installation signed out after the last account goes', async () => {
    const store = new KiroAccountStore(directory)
    const only = await store.upsert({ credential: credential('one') })
    const result = await call('POST', '/kiro/api/accounts/remove', { accountId: only.accountId })
    expect(result.status).toBe(200)
    expect(result.value.value.accounts.accounts).toEqual([])
    expect(result.value.value.accounts.activeAccountId).toBeNull()
    await expect(stat(join(directory, 'kiro-auth-token.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

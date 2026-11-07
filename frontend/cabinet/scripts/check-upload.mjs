// Real Uppy and production upload orchestration; only S3 transport and REST are local fakes.
// Run: node --experimental-vm-modules scripts/check-upload.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { File } from 'node:buffer'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SourceTextModule, SyntheticModule } from 'node:vm'
import { setImmediate as tick } from 'node:timers/promises'
import test from 'node:test'
import ts from 'typescript'
import Uppy, { BasePlugin } from '@uppy/core'
import ru from '@uppy/locales/lib/ru_RU.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
async function harness(confirm, stopAfter = Infinity) {
  const batches = []
  const deleted = []
  const sent = deferred()
  let next = 0
  class ApiError extends Error {}
  const api = {
    presign: async () => ({ photo_id: String(++next), url: 'local' }),
    deletePhoto: async (id) => { deleted.push(id) },
    confirm: async (_, ids) => {
      batches.push(ids)
      return confirm(ids, batches.length)
    },
  }
  class LocalS3 extends BasePlugin {
    constructor(uppy, opts) {
      super(uppy, opts)
      this.id = 'LocalS3'
      this.type = 'uploader'
    }
    upload = async (ids) => {
      for (let i = 0; i < ids.length; i++) {
        const file = this.uppy.getFile(ids[i])
        await this.opts.getUploadParameters(file)
        if (i === stopAfter) {
          sent.resolve()
          return new Promise(() => {})
        }
        this.uppy.emit('upload-success', this.uppy.getFile(file.id), { status: 200, body: {} })
      }
      sent.resolve()
    }
    install() { this.uppy.addUploader(this.upload) }
    uninstall() { this.uppy.removeUploader(this.upload) }
  }
  const cache = new Map()
  function synthetic(key, exports) {
    if (!cache.has(key)) cache.set(key, new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }))
    return cache.get(key)
  }
  async function load(path) {
    if (cache.has(path)) return cache.get(path)
    const source = await readFile(path, 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    const mod = new SourceTextModule(code, { identifier: path })
    cache.set(path, mod)
    await mod.link(async (specifier, parent) => {
      if (specifier === '@uppy/core') return synthetic(specifier, { default: Uppy })
      if (specifier === '@uppy/aws-s3') return synthetic(specifier, { default: LocalS3 })
      if (specifier === '@uppy/locales/lib/ru_RU') return synthetic(specifier, { default: ru })
      if (specifier === '../api') return synthetic('api', { api, ApiError })
      if (specifier === './errorReport') return synthetic('report', { reportError: () => {} })
      if (specifier === './heicPreview') return synthetic('heic', { isHeic: () => false, heicPreviewURL: async () => undefined })
      return load(resolve(dirname(parent.identifier), specifier + '.ts'))
    })
    return mod
  }
  const mod = await load(resolve(root, 'src/lib/uploadRun.ts'))
  await mod.evaluate()
  const inflight = cache.get(resolve(root, 'src/lib/inflight.ts')).namespace
  function run(count, controller = new AbortController(), onConfirmed = () => {}) {
    let refreshed = 0
    const files = Array.isArray(count) ? count : Array.from({ length: count }, (_, i) => ({ key: `k${i + 1}`, file: new File(['photo'], `${i}.jpg`, { type: 'image/jpeg' }) }))
    const promise = mod.namespace.uploadToAlbum({
      shopId: 'shop', albumId: 'album',
      files,
      signal: controller.signal, onProgress: () => {}, onConfirmed: () => { refreshed++; return onConfirmed() },
    })
    return { promise, files, refreshed: () => refreshed }
  }
  return { run, batches, deleted, sent, inflight, formatMB: mod.namespace.formatMB, photos: () => next }
}
const processing = (ids) => ({ results: ids.map((photo_id) => ({ photo_id, status: 'processing' })) })

test('does not finish or release unload protection before confirm completes', async () => {
  const gate = deferred()
  const h = await harness(async (ids) => { await gate.promise; return processing(ids) })
  const run = h.run(1)
  let finished = false
  run.promise.then(() => { finished = true })
  await h.sent.promise
  await tick()
  const before = { finished, inflight: h.inflight.uploadsInFlight() }
  gate.resolve()
  const result = await run.promise
  await tick()
  assert.equal(before.finished, false, 'upload resolved while confirm was still pending')
  assert.ok(before.inflight > 0)
  assert.deepEqual([...result.ok], ['k1'])
  assert.equal(result.failed.length, 0)
  assert.equal(h.inflight.uploadsInFlight(), 0)
})

test('confirm transport failure is returned per file, not as upload success', async () => {
  const h = await harness(async () => { throw new Error('offline') })
  const { promise } = h.run(2)
  const result = await promise
  await tick()
  assert.equal(result.ok.length, 0)
  assert.deepEqual(result.failed.map((f) => f.key), ['k1', 'k2'])
  assert.ok(result.failed.every((f) => /подтверд/i.test(f.message)))
  assert.equal(h.inflight.uploadsInFlight(), 0)
})

test('partial confirm reports only accepted files as successful and preserves quota reason', async () => {
  const h = await harness(async (ids) => ({ results: [
    { photo_id: ids[0], status: 'processing' },
    { photo_id: ids[1], status: 'error', code: 'quota_exceeded' },
  ] }))
  const result = await h.run(2).promise
  await tick()
  assert.deepEqual([...result.ok], ['k1'])
  assert.deepEqual(result.failed.map((f) => f.key), ['k2'])
  assert.equal(result.quota, 'закончилось место в хранилище')
})

test('300 files keep reverse chunk order and retain successes when a later chunk fails', async () => {
  const h = await harness(async (ids, n) => {
    if (n === 2) throw new Error('offline')
    return processing(ids)
  })
  const result = await h.run(300).promise
  await tick()
  assert.deepEqual(h.batches.map((ids) => ids.length), [100, 200])
  assert.equal(h.batches[0][0], '201')
  assert.equal(result.ok.length, 100)
  assert.equal(result.failed.length, 200)
  assert.ok(result.ok.includes('k201'))
  assert.equal(h.inflight.uploadsInFlight(), 0)
})

test('abort waits for already uploaded files to confirm, cancels unfinished files once', async () => {
  const gate = deferred()
  const h = await harness(async (ids) => { await gate.promise; return processing(ids) }, 1)
  const controller = new AbortController()
  const { promise } = h.run(2, controller)
  await h.sent.promise
  controller.abort()
  let finished = false
  promise.then(() => { finished = true })
  await tick()
  const before = finished
  gate.resolve()
  const result = await promise
  await tick()
  assert.equal(before, false)
  assert.equal(result.stopped, true)
  assert.deepEqual([...result.ok], ['k1'])
  assert.deepEqual(h.deleted, ['2'])
  assert.equal(h.batches.length, 1)
  assert.equal(h.inflight.uploadsInFlight(), 0)
})

test('missing confirm result cannot silently mark a file successful', async () => {
  const h = await harness(async () => ({ results: [] }))
  const result = await h.run(1).promise
  await tick()
  assert.equal(result.ok.length, 0)
  assert.deepEqual(result.failed.map((f) => f.key), ['k1'])
})


test('zero bytes stay zero while nonzero small files retain the 1 KB floor', async () => {
  const { formatMB } = await harness(async (ids) => processing(ids))
  assert.equal(formatMB(0), '0 КБ')
  assert.equal(formatMB(1), '1 КБ')
  assert.equal(formatMB(1024), '1 КБ')
  assert.equal(formatMB(1024 * 1024), '1,0 МБ')
})

test('a throwing UI refresh cannot strand the result or unload protection', { timeout: 1000 }, async () => {
  const h = await harness(async (ids) => processing(ids))
  const result = await h.run(1, new AbortController(), () => { throw new Error('refresh failed') }).promise
  assert.deepEqual([...result.ok], ['k1'])
  assert.equal(h.inflight.uploadsInFlight(), 0)
})

test('abort during confirm keeps all uploaded IDs and returns stopped', async () => {
  const gate = deferred()
  const h = await harness(async (ids) => { await gate.promise; return processing(ids) })
  const controller = new AbortController()
  const { promise } = h.run(2, controller)
  await h.sent.promise
  await tick()
  controller.abort()
  gate.resolve()
  const result = await promise
  assert.equal(result.stopped, true)
  assert.deepEqual([...result.ok], ['k1', 'k2'])
  assert.deepEqual(h.batches.flat(), ['1', '2'])
  assert.deepEqual(h.deleted, [])
  assert.equal(h.inflight.uploadsInFlight(), 0)
})


test('retry after an uncertain confirm reuses the uploaded photo ID without another PUT/presign', async () => {
  const h = await harness(async (ids, n) => {
    if (n === 1) throw new Error('response lost')
    return processing(ids)
  })
  const first = h.run(1)
  const failed = await first.promise
  assert.equal(failed.failed.length, 1)
  const retried = await h.run(first.files).promise
  assert.deepEqual([...retried.ok], ['k1'])
  assert.equal(h.photos(), 1, 'retry created a duplicate photo instead of retrying confirm')
  assert.deepEqual(h.batches.flat(), ['1', '1'])
  assert.equal(h.inflight.uploadsInFlight(), 0)
})


test('a rejected async refresh still returns confirmed files and releases counters', { timeout: 1000 }, async () => {
  const h = await harness(async (ids) => processing(ids))
  const result = await h.run(1, new AbortController(), async () => { throw new Error('refresh failed') }).promise
  assert.deepEqual([...result.ok], ['k1'])
  assert.equal(h.inflight.uploadsInFlight(), 0)
})

test('successful confirms clear retry state so a deliberate new upload gets a new ID', async () => {
  const h = await harness(async (ids) => processing(ids))
  const first = h.run(1)
  await first.promise
  await h.run(first.files).promise
  assert.equal(h.photos(), 2)
  assert.deepEqual(h.batches.flat(), ['1', '2'])
})

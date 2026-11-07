import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const selectedID = '00000000-0000-4000-8000-000000000061'
const first = { id: 'first', urls: { medium: 'https://cdn.test/first.webp' } }
const selected = { id: selectedID, caption: 'Selected photo 61', urls: { medium: 'https://cdn.test/61.webp' } }

function compile(path, imports, fetch) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}
  vm.runInNewContext(code, { exports, process, fetch, require: (name) => imports[name] ?? require(name) })
  return exports
}

function setup({ missing = false, locked = false } = {}) {
  const requests = []
  const data = {
    shop: { slug: 'shop', name: 'Shop' },
    album: { id: 'album-id', slug: 'album', title: 'Album', photo_count: 61, locked, has_password: locked },
    photos: locked ? [] : [first],
  }
  const fetch = async (url, options) => {
    requests.push({ url, options })
    let payload = data
    let status = 200
    if (url.includes('/photos/')) { payload = selected; status = missing ? 404 : 200 }
    else if (url.endsWith('/categories')) payload = []
    else if (url.endsWith('/shops/shop')) payload = { shop: data.shop }
    return { status, ok: status === 200, json: async () => payload }
  }
  const api = compile('../lib/api.ts', {}, fetch)
  const page = compile('../app/[slug]/[albumSlug]/page.tsx', {
    '@/lib/api': api,
    '@/components/AlbumView': {},
    '@/components/ShopUnavailable': {},
    'next/navigation': {},
  }, fetch)
  return { requests, metadata: (p) => page.generateMetadata({ params: { slug: 'shop', albumSlug: 'album' }, searchParams: { p } }) }
}

test('metadata loads shared photo beyond first 60 by ID with shop cache tag', async () => {
  const { metadata, requests } = setup()
  const result = await metadata(selectedID)
  assert.equal(result.openGraph.images[0].url, selected.urls.medium)
  assert.equal(result.openGraph.title, `${selected.caption} — Shop`)
  const request = requests.find((r) => r.url.endsWith(`/albums/album-id/photos/${selectedID}`))
  assert.ok(request)
  assert.equal(request.options.next.revalidate, 60)
  assert.equal(request.options.next.tags[0], 'shop:shop')
})

test('repeated p uses first value', async () => {
  const { metadata } = setup()
  assert.equal((await metadata([selectedID, 'other'])).openGraph.images[0].url, selected.urls.medium)
})

test('missing shared photo falls back to album cover', async () => {
  const { metadata } = setup({ missing: true })
  assert.equal((await metadata(selectedID)).openGraph.images[0].url, first.urls.medium)
})

test('locked album never requests or exposes shared photo', async () => {
  const { metadata, requests } = setup({ locked: true })
  assert.equal((await metadata(selectedID)).openGraph.images, undefined)
  assert.equal(requests.some((r) => r.url.includes('/photos/')), false)
})

test('absent p keeps album cover without fetching a photo', async () => {
  const { metadata, requests } = setup()
  assert.equal((await metadata(undefined)).openGraph.images[0].url, first.urls.medium)
  assert.equal(requests.some((r) => r.url.includes('/photos/')), false)
})

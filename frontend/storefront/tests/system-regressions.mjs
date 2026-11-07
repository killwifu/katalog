// Run: node tests/system-regressions.mjs (from frontend/storefront, after npm ci).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const storefront = path.resolve(__dirname, '..')
const element = (type, props) => ({ type, props })

function load(file, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(storefront, file), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}
  vm.runInNewContext(code, {
    exports,
    URL,
    URLSearchParams,
    Response,
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
      if (name in dependencies) return dependencies[name]
      if (name.startsWith('@/components/') || name.startsWith('./') || name === 'lucide-react') {
        return new Proxy({}, { get: (_, key) => key })
      }
      throw new Error(`Unexpected import: ${name}`)
    },
    ...globals,
  }, { filename: file })
  return exports
}

const redirects = []
const search = load('app/[slug]/search/page.tsx', {
  'next/navigation': {
    redirect: (url) => { redirects.push(url); throw new Error('redirect') },
    notFound: () => { throw new Error('notFound') },
  },
  '@/lib/api': {
    getShopPage: async () => ({ shop: { id: 'shop', name: 'Shop' }, albums: [], tabs: [] }),
    getCategories: async () => [],
    loadOrUnavailable: async (fn) => ({ ok: true, data: await fn() }),
    withAlbumCounts: (categories) => categories,
  },
  '@/lib/links': { messageText: () => '' },
  '@/lib/sort': { sortAlbums: (albums) => albums },
})

async function searchProps(params) {
  const tree = await search.default({ params: { slug: 'shop' }, searchParams: params })
  return tree.props.children.find((child) => child?.type === 'ShopHeader').props
}

const album = { id: 'album', slug: 'album', title: 'Album', photo_count: 2 }
const shopData = {
  shop: { id: 'shop', slug: 'shop', name: 'Shop', contacts: {} },
  albums: [album], tabs: [{ slug: 'albums', title: 'Albums' }],
}
const albumData = {
  shop: shopData.shop, album, photos: [{ id: 'photo', caption: 'Photo', urls: { medium: '/photo.webp' } }],
  page: 1, total: 1,
}
const routeDependencies = {
  'next/navigation': {
    redirect: (url) => { throw new Error(`redirect:${url}`) },
    permanentRedirect: (url) => { throw new Error(`redirect:${url}`) },
    notFound: () => { throw new Error('notFound') },
  },
  '@/lib/api': {
    getShopPage: async () => shopData,
    getAlbumPage: async () => albumData,
    getPublicPhoto: async (_slug, _albumID, photoID) => albumData.photos.find((p) => p.id === photoID) ?? null,
    getCategories: async () => [{ slug: 'category', title: 'Category', parent_slug: null }],
    getCategoryAlbums: async () => [album],
    getTabSections: async () => [],
    loadOrUnavailable: async (fn) => ({ ok: true, data: await fn() }),
    withAlbumCounts: (categories) => categories,
    albumHref: (slug, value) => `/${slug}/${value.slug}`,
  },
  '@/lib/sort': load('lib/sort.ts', {}),
  '@/lib/links': { shopChannels: () => [], messageText: () => '' },
  '@/components/ShopHome': { ALBUMS_PER_PAGE: 24 },
  '@/components/ShopHeader': { ShopHeader: 'ShopHeader', albumsWord: () => 'альбом' },
}

async function savedTokenCheck(fetchImpl, { saved = true, unmount = false } = {}) {
  const states = []
  const effects = []
  const rejected = []
  const onRejection = (error) => rejected.push(error)
  process.on('unhandledRejection', onRejection)
  try {
    let slot = 0
    const component = load('components/LockedAlbum.tsx', {
      react: {
        useState: (initial) => {
          const index = slot++
          states[index] = initial
          return [initial, (value) => { states[index] = value }]
        },
        useEffect: (fn) => effects.push(fn),
      },
      '@/lib/links': {},
    }, {
      fetch: fetchImpl,
      localStorage: { getItem: () => saved ? 'saved-token' : null },
    })
    component.LockedAlbum({ slug: 'shop', albumId: 'album', albumSlug: 'album', head: {} })
    const cleanup = effects[0]()
    if (unmount) cleanup?.()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(rejected.length, 0, 'saved-token check must handle rejected promises')
    return states
  } finally {
    process.removeListener('unhandledRejection', onRejection)
  }
}

const tests = [
  ...['app/[slug]/t/[tabSlug]/page.tsx', 'app/[slug]/c/[categorySlug]/page.tsx'].map((file) => [
    `repeated page/sort/q/from do not crash ${file}`,
    async () => {
      const page = load(file, routeDependencies)
      const result = await page.default({
        params: { slug: 'shop', tabSlug: 'albums', categorySlug: 'category' },
        searchParams: { page: ['1', '2'], sort: ['photos', 'new'], q: ['a', 'b'], from: ['/shop', '/shop'] },
      })
      assert.equal(result.type, 'main')
    },
  ]),
  ['repeated p does not crash album metadata', async () => {
    const page = load('app/[slug]/[albumSlug]/page.tsx', routeDependencies)
    const metadata = await page.generateMetadata({
      params: { slug: 'shop', albumSlug: 'album' }, searchParams: { p: ['photo', 'other'] },
    })
    assert.equal(metadata.title, 'Album — Shop')
  }],
  ['legacy album URL safely skips repeated query values', async () => {
    const page = load('app/[slug]/a/[albumId]/page.tsx', routeDependencies)
    await assert.rejects(page.default({
      params: { slug: 'shop', albumId: 'album' },
      searchParams: { p: ['photo', 'other'], q: ['a', 'b'], from: ['/shop', '/shop'], keep: 'yes' },
    }), /redirect:\/shop\/album\?keep=yes$/)
  }],
  ['photos route reads first repeated page value', async () => {
    let requestedPage
    const route = load('app/[slug]/[albumSlug]/photos/route.ts', {
      '@/lib/api': { getAlbumPage: async (_, __, page) => { requestedPage = page; return albumData } },
    })
    const response = await route.GET({ url: 'http://example.test/shop/album/photos?page=1&page=2' }, {
      params: { slug: 'shop', albumSlug: 'album' },
    })
    assert.equal(response.status, 200)
    assert.equal(requestedPage, 1)
  }],
  ['repeated q uses first value', async () => {
    assert.equal((await searchProps({ q: [' boots ', 'hats'] })).search, 'boots')
  }],
  ['repeated from uses first value', async () => {
    assert.equal((await searchProps({ q: 'boots', from: ['/shop/t/albums', '/shop'] })).from, '/shop/t/albums')
  }],
  ...['/shop-other', '/shop%2F..', '//example.com/shop'].map((from) => [
    `return path rejects ${from}`,
    async () => {
      assert.equal((await searchProps({ q: 'boots', from: [from, '/shop/t/albums'] })).from, '/shop')
      await assert.rejects(searchProps({ q: '', from }), /redirect/)
      assert.equal(redirects.at(-1), '/shop')
    },
  ]),
  ...['/shop', '/shop/t/albums', '/shop?sort=photos'].map((from) => [
    `return path accepts ${from}`,
    async () => {
      assert.equal((await searchProps({ q: 'boots', from })).from, from)
      await assert.rejects(searchProps({ q: '', from: [from, '/shop-other'] }), /redirect/)
      assert.equal(redirects.at(-1), from)
    },
  ]),
  ['metadata uses first q value', () => {
    assert.equal(search.generateMetadata({ searchParams: { q: ['boots', 'hats'] } }).title, 'Поиск «boots»')
  }],
  ['ordinary search and external return fallback still work', async () => {
    const props = await searchProps({ q: ' boots ', from: 'https://example.com' })
    assert.equal(props.search, 'boots')
    assert.equal(props.from, '/shop')
  }],
  ['empty first q redirects to normalized from', async () => {
    await assert.rejects(searchProps({ q: ['', 'boots'], from: ['/shop/t/albums', '/shop'] }), /redirect/)
    assert.equal(redirects.at(-1), '/shop/t/albums')
  }],
  ['saved-token rejected fetch shows form and error', async () => {
    const states = await savedTokenCheck(async () => { throw new TypeError('Failed to fetch') })
    assert.equal(states[2], 'form')
    assert.match(states[4], /Нет связи/)
  }],
  ['saved-token success still opens album', async () => {
    const album = { album: { locked: false }, photos: [] }
    const states = await savedTokenCheck(async () => ({ ok: true, json: async () => album }))
    assert.equal(states[0], album)
    assert.equal(states[1], 'saved-token')
    assert.equal(states[2], 'form')
  }],
  ['expired token returns to password form', async () => {
    const states = await savedTokenCheck(async () => ({ ok: true, json: async () => ({ album: { locked: true } }) }))
    assert.equal(states[0], null)
    assert.equal(states[2], 'form')
    assert.equal(states[4], '')
  }],
  ['no saved token does not fetch', async () => {
    const states = await savedTokenCheck(() => { throw new Error('unexpected fetch') }, { saved: false })
    assert.equal(states[2], 'form')
  }],
  ['unmounted failed check does not update state', async () => {
    const states = await savedTokenCheck(async () => { throw new TypeError('Failed to fetch') }, { unmount: true })
    assert.equal(states[2], 'checking')
    assert.equal(states[4], '')
  }],
]

;(async () => {
  let failures = 0
  for (const [name, run] of tests) {
    try {
      await run()
      console.log(`PASS ${name}`)
    } catch (error) {
      failures++
      console.error(`FAIL ${name}: ${error.message}`)
    }
  }
  console.log(`${tests.length - failures}/${tests.length} passed`)
  process.exitCode = failures ? 1 : 0
})()

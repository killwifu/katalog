import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const file = new URL('../components/SearchForm.tsx', import.meta.url)
const source = process.env.QA_TEST_REF
  ? execFileSync('git', ['show', `${process.env.QA_TEST_REF}:frontend/storefront/components/SearchForm.tsx`], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' })
  : fs.readFileSync(file, 'utf8')

function harness() {
  const storage = new Map()
  const timers = new Map()
  const routes = []
  let sequence = 0
  let refs
  let effect
  const exports = {}
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, {
    exports, JSON,
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    window: { setTimeout: (fn) => { timers.set(++sequence, fn); return sequence }, clearTimeout: (id) => timers.delete(id) },
    require: (name) => {
      if (name === 'react') return { useRef: (value) => { const ref = { current: value }; refs.push(ref); return ref }, useEffect: (fn) => { effect = fn } }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      if (name === 'next/navigation') return { useRouter: () => ({ push: (url) => routes.push(['push', url]), replace: (url) => routes.push(['replace', url]) }) }
      if (name === 'lucide-react') return { X: 'X' }
      throw Error(name)
    },
  })
  return {
    storage, routes, timers,
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()) },
    mount(initial, slug = 'shop') {
      refs = []
      const tree = exports.SearchForm({ slug, initial, from: `/${slug}` })
      const input = tree.props.children[0]
      const node = { value: initial ?? '', focus() {}, setSelectionRange() {} }
      refs[0].current = node
      const setup = effect
      const cleanup = setup()
      return { node, cleanup, setup, type: (value) => input.props.onChange({ target: { value } }) }
    },
  }
}

test('typing during first search navigation survives remount and updates results', () => {
  const h = harness()
  const home = h.mount()
  home.type('ку')
  h.flush()
  home.type('курт')
  home.cleanup()
  const results = h.mount('ку')
  assert.equal(results.node.value, 'курт')
  h.flush()
  assert.equal(h.routes.at(-1)[0], 'replace')
  assert.equal(new URL(h.routes.at(-1)[1], 'http://localhost').searchParams.get('q'), 'курт')
})

test('StrictMode effect replay keeps the latest pending search', () => {
  const h = harness()
  h.storage.set('search-focus', '1')
  h.storage.set('search-draft', JSON.stringify({ slug: 'shop', value: 'курт' }))
  const results = h.mount('ку')
  results.cleanup()
  const cleanup = results.setup()
  h.flush()
  assert.equal(new URL(h.routes.at(-1)[1], 'http://localhost').searchParams.get('q'), 'курт')
  cleanup()
})

test('draft from another shop does not replace its search text', () => {
  const h = harness()
  h.storage.set('search-focus', '1')
  h.storage.set('search-draft', JSON.stringify({ slug: 'other', value: 'wrong shop' }))
  const results = h.mount('shirt')
  assert.equal(results.node.value, 'shirt')
  h.flush()
  assert.equal(h.routes.length, 0)
})

test('malformed saved draft does not break search restoration', () => {
  const h = harness()
  h.storage.set('search-focus', '1')
  h.storage.set('search-draft', JSON.stringify({ slug: 'shop' }))
  const results = h.mount('shirt')
  assert.equal(results.node.value, 'shirt')
  h.flush()
  assert.equal(h.routes.length, 0)
})

// Execute the production restore closure with local REST doubles; no stand requests.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import ts from 'typescript'

const path = 'frontend/cabinet/src/pages/CategoriesPage.tsx'
const source = process.env.CABINET_TEST_REF
  ? execFileSync('git', ['show', `${process.env.CABINET_TEST_REF}:${path}`], { encoding: 'utf8' })
  : await readFile(new URL('../src/pages/CategoriesPage.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const closures = new Map()
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['restoreCategory', 'saveOrder'].includes(node.name.getText(ast))) {
    closures.set(node.name.getText(ast), node.getText(ast))
  }
  ts.forEachChild(node, visit)
}
visit(ast)
const code = ts.transpileModule(
  `const ${closures.get('saveOrder')}; const ${closures.get('restoreCategory')}; return restoreCategory;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText

const root = { id: 'old', title: 'Category', slug: 'category', parent_id: null, sort_order: 1, is_hidden: true, on_home: false }
async function restore(fail) {
  let toast
  let selected
  let refreshed = 0
  const calls = []
  const api = new Proxy({}, {
    get: (_, method) => async (...args) => {
      calls.push([method, ...args])
      if (method === fail) throw new Error('offline')
      if (method === 'createCategory') return { ...root, id: 'new' }
      if (method === 'listCategories') return [{ ...root, id: 'new' }]
    },
  })
  const run = new Function('api', 'shop', 'setSelected', 'setToast', 'refresh', code)(
    api, { id: 'shop' }, (id) => { selected = id }, (value) => { toast = value }, () => { refreshed++ },
  )
  await run([{ cat: root, albums: ['a1', 'a2'] }], ['old'])
  return { toast, selected, refreshed, calls }
}

for (const operation of ['updateCategory', 'setCategoryVisibility', 'addAlbumToCategory', 'setCategoryAlbumOrder']) {
  test(`restore reports partial failure of ${operation}`, async () => {
    const result = await restore(operation)
    assert.match(result.toast?.text ?? '', /частично/)
    assert.equal(result.refreshed, 1)
    assert.equal(result.selected, 'new')
    assert.equal(result.calls.filter(([method]) => method === 'addAlbumToCategory').length, 2)
    if (operation === 'addAlbumToCategory') {
      assert.equal(result.calls.some(([method]) => method === 'setCategoryAlbumOrder'), false)
    }
  })
}

test('successful restore keeps visibility, membership and album order without a false error', async () => {
  const result = await restore()
  assert.equal(result.toast, undefined)
  assert.equal(result.selected, 'new')
  assert.equal(result.refreshed, 1)
  assert.ok(result.calls.some(([method]) => method === 'setCategoryVisibility'))
  assert.ok(result.calls.some(([method]) => method === 'setCategoryAlbumOrder'))
})

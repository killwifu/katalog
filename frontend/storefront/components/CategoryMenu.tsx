import type { CategoryPublic } from '@/lib/api'

// Один компонент — три раскладки (kit: «Не делайте три реализации»):
//   dropdown — выпадающее меню в шапке витрины;
//   tree     — дерево слева на странице категории;
//   sheet    — шторка на телефоне.
//
// Раскрытие — нативный <details>, а не состояние React: компонент остаётся
// серверным и не тащит клиентский рантайм на горячий путь покупателя
// (95% трафика при бюджете 100 КБ gzip). aria-expanded браузер проставляет
// сам. Цена — Escape не закрывает панель, закрывает клик по заголовку.
type Layout = 'dropdown' | 'tree' | 'sheet'

type Props = {
  shopSlug: string
  categories: CategoryPublic[]
  layout: Layout
  activeSlug?: string
}

type Node = CategoryPublic & { children: CategoryPublic[] }

function buildTree(categories: CategoryPublic[]): Node[] {
  return categories
    .filter((c) => !c.parent_slug)
    .map((root) => ({
      ...root,
      children: categories.filter((c) => c.parent_slug === root.slug),
    }))
}

function CategoryList({
  nodes,
  shopSlug,
  activeSlug,
}: {
  nodes: Node[]
  shopSlug: string
  activeSlug?: string
}) {
  return (
    <ul className="cattree">
      {nodes.map((node) => (
        <li key={node.slug}>
          <a
            href={`/${shopSlug}/c/${node.slug}`}
            aria-current={node.slug === activeSlug ? 'page' : undefined}
          >
            {node.title}
            <span className="dim"> {node.album_count}</span>
          </a>
          {node.children.length > 0 && (
            <ul>
              {node.children.map((child) => (
                <li key={child.slug}>
                  <a
                    href={`/${shopSlug}/c/${child.slug}`}
                    aria-current={child.slug === activeSlug ? 'page' : undefined}
                  >
                    {child.title}
                    <span className="dim"> {child.album_count}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}

export function CategoryMenu({ shopSlug, categories, layout, activeSlug }: Props) {
  const nodes = buildTree(categories)
  if (nodes.length === 0) return null

  if (layout === 'tree') {
    return (
      <nav className="catmenu catmenu--tree" aria-label="Категории">
        <CategoryList nodes={nodes} shopSlug={shopSlug} activeSlug={activeSlug} />
      </nav>
    )
  }

  return (
    <nav className={`catmenu catmenu--${layout}`} aria-label="Категории">
      <details>
        <summary className="btn btn--ghost btn--sm">
          {layout === 'sheet' ? 'Категории' : 'Каталог'}
        </summary>
        <div className="catpick">
          <CategoryList nodes={nodes} shopSlug={shopSlug} activeSlug={activeSlug} />
        </div>
      </details>
    </nav>
  )
}

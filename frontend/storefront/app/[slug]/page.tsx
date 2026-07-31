// SSR-заглушка витрины магазина. Данные из /api/v1/public появятся
// на следующих этапах (SSR/ISR + ревалидация по вебхуку от Go).
export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ slug: string }>
}

export default async function ShopPage({ params }: Props) {
  const { slug } = await params
  return (
    <main>
      <h1>Магазин: {slug}</h1>
      <p>Заглушка витрины. Каталог появится на следующих этапах.</p>
    </main>
  )
}

import type { Metadata } from 'next'
import { Fragment } from 'react'
import { CtaBanner, PlanPrice, PlansSection } from '@/components/site/blocks'
import { CellValue } from './CellValue'
import { MATRIX, PLANS } from './plans'
import s from './pricing.module.css'

export const metadata: Metadata = {
  title: 'Тарифы — вуад',
  description:
    'Оплата помесячно или за год со скидкой 25%. Бесплатный тариф без ограничения по времени и без привязки карты, 7 дней «Про» бесплатно.',
}

// Страница тарифов по макету 08: карточки и свитч — как на главной, ниже
// подробное сравнение (колонка «Про» подсвечена). На телефоне строка
// таблицы — название сверху и значения по четырём тарифам под ним,
// шапка с тарифами закрепляется при прокрутке.
export default function PricingPage() {
  return (
    <main>
      <PlansSection h1 />

      <section className={s.cmp}>
        <div className={s.in}>
          <h2>Сравнение тарифов</h2>
          <p className={s.lead}>Что входит в каждый тариф и чем они отличаются</p>

          <table className={s.table}>
            <thead>
              <tr>
                <td className={s.label}>Тариф</td>
                {PLANS.map((p) => (
                  <th key={p.id} scope="col" className={p.featured ? s.hl : undefined}>
                    {p.featured && <span className={s.badge}>Выбирают чаще</span>}
                    <span className={s.planName}>{p.name}</span>
                    <PlanPrice price={p.price} priceYear={p.priceYear} small />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MATRIX.map((group) => (
                <Fragment key={group.title}>
                  <tr className={s.group}>
                    <th scope="colgroup" colSpan={PLANS.length + 1}>
                      {group.title}
                    </th>
                  </tr>
                  {group.rows.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      {PLANS.map((p) => (
                        <td key={p.id} className={p.featured ? s.hl : undefined}>
                          <CellValue value={row.values[p.id]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <CtaBanner />
    </main>
  )
}

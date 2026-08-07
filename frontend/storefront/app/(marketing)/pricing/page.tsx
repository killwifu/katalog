import type { Metadata } from 'next'
import { Fragment } from 'react'
import { StickyBar } from '@/components/site/StickyBar'
import { CellValue } from './CellValue'
import { PlanTabs } from './PlanTabs'
import { MATRIX, PLANS, formatPrice } from './plans'
import styles from './pricing.module.css'

export const metadata: Metadata = {
  title: 'Тарифы — Katalog',
  description:
    'Платите за место, а не за покупателей. Просмотры витрины не ограничены на любом тарифе.',
}

const FACTS = [
  'Просмотры не ограничены',
  'SSL и превью в мессенджерах',
  'Фото не удаляются при неоплате',
]

const FAQ = [
  {
    q: 'Что будет, если не продлить подписку?',
    a: 'Ещё 7 дней витрина работает для покупателей как обычно, только загрузка новых фото недоступна. Потом витрина скрывается, а по старой ссылке покупатель видит страницу с вашими контактами. Фотографии и альбомы хранятся в кабинете 3 месяца — возобновите подписку, и витрина откроется в прежнем виде.',
  },
  {
    q: 'Что если фото больше, чем в новом тарифе?',
    a: 'Мы ничего не удаляем. Предложим выбрать, какие фотографии останутся видимыми — например, самые просматриваемые, — а остальные подождут в кабинете до повышения тарифа.',
  },
  {
    q: 'А если места не хватит?',
    a: 'Дополнительные 20 ГБ — 190 ₽ в месяц, подключаются и отключаются в кабинете.',
  },
  {
    q: 'Как оплатить?',
    a: 'Российской картой или через СБП, с автопродлением или разовым платежом. Для юрлиц — счёт и закрывающие документы.',
  },
]

const featured = PLANS.find((p) => p.featured)

export default function PricingPage() {
  return (
    <>
      <main>
        <section className={styles.top}>
          <div className="wrap">
            <h1>Платите за место, а не за покупателей</h1>
            <p>
              Просмотры витрины не ограничены ни на одном тарифе. Попробовать можно бесплатно
              и без карты, а при оплате за год — минус 25%.
            </p>
          </div>
        </section>

        <section className="wrap">
          <div className={styles.cards}>
            {PLANS.map((plan) => (
              <article
                key={plan.id}
                className={`card ${plan.featured ? 'card--accent' : ''} ${styles.card}`}
              >
                {plan.featured && <span className={`tag ${styles.badge}`}>выбирают чаще</span>}
                <span className={styles.name}>{plan.name}</span>
                <span className={styles.price}>
                  {formatPrice(plan.price)} ₽{plan.price > 0 && <small>/мес</small>}
                </span>
                <span className={styles.note}>
                  {plan.yearPrice
                    ? `${formatPrice(plan.yearPrice)} ₽ при оплате за год`
                    : 'навсегда'}
                </span>
                <a
                  className={`btn ${plan.featured ? 'btn--primary' : 'btn--ghost'}`}
                  href="/app/register"
                >
                  {plan.cta}
                </a>
                <ul className="ticks">
                  {plan.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <div className={styles.facts}>
            {FACTS.map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section__head">
              <h2>Сравнение возможностей</h2>
              <p>
                Тариф можно менять в любой момент, деньги за остаток периода пересчитываются.
              </p>
            </div>

            <table className={styles.matrix}>
              <thead>
                <tr>
                  <td />
                  {PLANS.map((plan) => (
                    <th key={plan.id} scope="col" className={plan.featured ? styles.hl : undefined}>
                      {plan.featured && <span className="tag">выбирают чаще</span>}
                      {plan.name}
                      <small>
                        {plan.price === 0 ? '0 ₽' : `${formatPrice(plan.price)} ₽/мес`}
                      </small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MATRIX.map((group) => (
                  <Fragment key={group.title}>
                    <tr className={styles.group}>
                      <th scope="row">{group.title}</th>
                      {PLANS.map((plan) => (
                        <td key={plan.id} className={plan.featured ? styles.hl : undefined} />
                      ))}
                    </tr>
                    {group.rows.map((row) => (
                      <tr key={row.label}>
                        <th scope="row">{row.label}</th>
                        {PLANS.map((plan) => {
                          const value = row.values[plan.id]
                          // Одинаковое во всех тарифах — приглушаем, чтобы
                          // взгляд цеплялся за различия.
                          const uniform =
                            typeof value === 'string' &&
                            PLANS.every((p) => row.values[p.id] === value)
                          return (
                            <td
                              key={plan.id}
                              className={
                                [plan.featured ? styles.hl : '', uniform ? styles.same : '']
                                  .filter(Boolean)
                                  .join(' ') || undefined
                              }
                            >
                              <CellValue value={value} />
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
                <tr className={styles.ctaRow}>
                  <td />
                  {PLANS.map((plan) => (
                    <td key={plan.id} className={plan.featured ? styles.hl : undefined}>
                      <a
                        className={`btn ${plan.featured ? 'btn--primary' : 'btn--ghost'} btn--sm`}
                        href="/app/register"
                      >
                        {plan.price === 0 ? 'Начать' : 'Выбрать'}
                      </a>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>

            <PlanTabs />
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <h2>Частые вопросы</h2>
            <dl className={styles.faq}>
              {FAQ.map((item) => (
                <Fragment key={item.q}>
                  <dt>{item.q}</dt>
                  <dd>{item.a}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        </section>
      </main>

      {featured && (
        <StickyBar
          title={`${featured.name} · ${formatPrice(featured.price)} ₽/мес`}
          note="14 дней бесплатно"
          action="Начать"
          href="/app/register"
        />
      )}
    </>
  )
}

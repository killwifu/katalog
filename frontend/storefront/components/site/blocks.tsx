import type { ReactNode } from 'react'
import { PLANS, formatPrice } from '@/app/(marketing)/pricing/plans'
import { PlanLink } from './PlanLink'
import s from './landing.module.css'

// Блоки, общие для главной и страницы тарифов (макеты 01, 07, 08).

/** Плашка над заголовком раздела: «Преимущества», «Аналитика», «Тарифы». */
export function Pill({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className={s.pill}>
      <span className={s.pillIc} aria-hidden="true">
        {icon}
      </span>
      {children}
    </span>
  )
}

/** Цена тарифа: помесячная и годовая, видна одна — по свитчу #plan-year (CSS). */
export function PlanPrice({ price, priceYear, small }: { price: number; priceYear: number; small?: boolean }) {
  const cls = small ? s.priceSm : s.price
  if (price === 0) {
    return (
      <span className={cls}>
        0 ₽<small>навсегда</small>
      </span>
    )
  }
  return (
    <>
      <span className={`${cls} ${s.m}`}>
        {formatPrice(price)} ₽<small>/мес</small>
      </span>
      <span className={`${cls} ${s.y}`}>
        {formatPrice(priceYear)} ₽<small>/год</small>
      </span>
    </>
  )
}

const tick = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#1b6b3a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
)
const minus = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#cfccc4" strokeWidth="2.3" strokeLinecap="round" aria-hidden="true">
    <path d="M4 8h8" />
  </svg>
)

/** Раздел «Тарифы»: плашка, заголовок, свитч «Помесячно / За год», 4 карточки. */
export function PlansSection({ h1, compareLink }: { h1?: boolean; compareLink?: boolean }) {
  const Title = h1 ? 'h1' : 'h2'
  return (
    <section className={s.plansSec} id="plans">
      <div className={`${s.in} ${s.center}`}>
        <Pill icon={<b>₽</b>}>Тарифы</Pill>
        <Title className={s.h2}>
          Постоянный поток клиентов <br className={s.brDesk} />
          без дополнительных затрат
        </Title>
        <p className={s.secLead}>
          Оплата помесячно или за год со скидкой 25%, автопродление можно отключить в любой момент. При переходе
          на тариф выше доплачиваете только за остаток периода.
        </p>
        <label className={s.switch}>
          <span className={s.swMonth}>Помесячно</span>
          <input id="plan-year" type="checkbox" role="switch" aria-label="Оплата за год" />
          <span className={s.swYear}>За год</span>
          <span className={s.save}>−25%</span>
        </label>
      </div>

      <div className={s.plansScroll}>
        <div className={s.plans}>
          {PLANS.map((p) => (
            <article key={p.id} className={`${s.plan} ${p.featured ? s.planHl : ''}`}>
              <div className={s.planTop}>
                <span className={s.planName}>{p.name}</span>
                {p.featured && <span className={s.badge}>Выбирают чаще</span>}
              </div>
              <div className={s.planHead}>
                <PlanPrice price={p.price} priceYear={p.priceYear} />
                {p.price > 0 && (
                  <span className={`${s.saving} ${s.y}`}>Экономия {formatPrice(p.price * 12 - p.priceYear)} ₽</span>
                )}
                <span className={s.tagline}>{p.tagline}</span>
              </div>
              <ul className={s.feats}>
                {p.bullets.map((b) => (
                  <li key={b.text} className={b.off ? s.off : undefined}>
                    {b.off ? minus : tick}
                    {b.text}
                  </li>
                ))}
              </ul>
              <div className={s.planFoot}>
                {p.id === 'pro' && <span className={s.trialNote}>7 дней бесплатно, без карты</span>}
                <PlanLink plan={p.id} className={`${s.btn} ${s.btnLg} ${p.featured ? s.btnPrimary : s.btnOutline}`}>
                  {p.cta}
                </PlanLink>
              </div>
            </article>
          ))}
        </div>
      </div>

      {compareLink && (
        <p className={s.center}>
          <a className={s.textLink} href="/pricing">
            Подробное сравнение тарифов →
          </a>
        </p>
      )}
    </section>
  )
}

/** Синий баннер «Соберите витрину сегодня…» над подвалом. */
export function CtaBanner() {
  return (
    <section className={s.ctaSec}>
      <div className={s.in}>
        <div className={s.banner}>
          <div className={s.bannerText}>
            <h2>Соберите витрину сегодня и отправьте ссылку клиентам</h2>
            <p>
              Загрузите фото, разложите их по альбомам и категориям — и вместо сотни фото в чатах отправляйте
              покупателям одну ссылку. Бесплатный тариф без ограничения по времени и без привязки карты.
            </p>
          </div>
          <a className={`auth-out ${s.btn} ${s.btnOnBlue}`} href="/app/register">
            Начать бесплатно
          </a>
          <a className={`auth-in ${s.btn} ${s.btnOnBlue}`} href="/app/">
            Начать бесплатно
          </a>
        </div>
      </div>
    </section>
  )
}

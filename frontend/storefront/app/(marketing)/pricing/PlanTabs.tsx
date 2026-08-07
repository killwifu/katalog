'use client'

import { useState } from 'react'
import { CellValue } from './CellValue'
import { MATRIX, PLANS, formatPrice, type Plan } from './plans'
import styles from './pricing.module.css'

// Мобильная версия таблицы сравнения: те же MATRIX и PLANS,
// но по одному тарифу за раз — таблица из пяти колонок на телефон не влезает.
export function PlanTabs() {
  const [active, setActive] = useState<Plan['id']>('sell')
  const plan = PLANS.find((p) => p.id === active) ?? PLANS[0]

  return (
    <div className={styles.mobileMatrix}>
      <div className={styles.tabs} role="tablist">
        {PLANS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={p.id === active}
            aria-controls={`plan-panel-${p.id}`}
            onClick={() => setActive(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>

      <div id={`plan-panel-${plan.id}`} role="tabpanel">
        {plan.featured && <span className="tag">выбирают чаще</span>}
        <div className={styles.panelPrice}>
          {formatPrice(plan.price)} ₽{plan.price > 0 && <small>/мес</small>}
        </div>
        <p className={`dim ${styles.panelNote}`}>
          {plan.yearPrice ? `${formatPrice(plan.yearPrice)} ₽ при оплате за год` : 'навсегда, без карты'}
        </p>
        <a
          className={`btn ${plan.featured ? 'btn--primary' : 'btn--ghost'} btn--block`}
          href="/app/register"
        >
          {plan.cta}
        </a>

        {MATRIX.map((group) => (
          <div key={group.title}>
            <p className={styles.rowGroup}>{group.title}</p>
            {group.rows.map((row) => (
              <div key={row.label} className={styles.row}>
                <span>{row.label}</span>
                <span>
                  <CellValue value={row.values[plan.id]} />
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

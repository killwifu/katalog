import type { Metadata } from 'next'
import { StickyBar } from '@/components/site/StickyBar'
import styles from './home.module.css'
import { PLANS, formatPrice } from './pricing/plans'

export const metadata: Metadata = {
  title: 'Katalog — весь ваш товар в одной ссылке',
  description:
    'Загрузите товары, разложите по категориям и отправляйте покупателю одну ссылку вместо десятков фотографий в переписке.',
}

// Иконки нарисованы инлайном в стиле Lucide: четыре штуки не стоят зависимости.
const FEATURES = [
  {
    title: 'Загрузка прямо с телефона',
    text: 'Выделили сотню фото — они сами сжались и встали в нужном порядке.',
    icon: (
      <>
        <path d="M15 8h.01" />
        <path d="M12.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7.5" />
        <path d="m3 16 5-5c.93-.9 2.07-.9 3 0l4 4" />
        <path d="M16 19h6M19 16v6" />
      </>
    ),
  },
  {
    title: 'Ваш ник на каждом фото',
    text: 'Водяной знак ставится автоматически, чтобы съёмку не забрали себе другие.',
    icon: <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />,
  },
  {
    title: 'Чистый фон в один клик',
    text: 'Товар с ковра на полу выглядит как со студийной съёмки. Без фотошопа.',
    icon: (
      <>
        <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
        <path d="M22 21H7" />
        <path d="m5 11 9 9" />
      </>
    ),
  },
  {
    title: 'Видно, что смотрят',
    text: 'Какие товары открывают чаще и откуда приходят покупатели.',
    icon: (
      <>
        <path d="M3 3v16a2 2 0 0 0 2 2h16" />
        <path d="M7 16v-5M12 16V8M17 16v-3" />
      </>
    ),
  },
]

const STEPS = [
  {
    title: 'Загрузите фото',
    text: 'С телефона или компьютера. Уже торгуете на Yupoo — перенесём альбомы по ссылке.',
  },
  {
    title: 'Разложите по полкам',
    text: 'Категории и разделы называете сами. Меняется в любой момент.',
  },
  {
    title: 'Отправьте ссылку',
    text: 'В Telegram и WhatsApp она разворачивается в красивое превью.',
  },
]

// Короткие подписи для главной: на странице тарифов у тех же планов
// развёрнутые списки возможностей.
const PLAN_SUMMARY: Record<string, string> = {
  start: '100 фото, 10 альбомов',
  sell: '5 000 фото, водяной знак, статистика',
  biz: '30 000 фото, свой домен, сотрудники',
}

export default function HomePage() {
  const shownPlans = PLANS.filter((p) => p.id in PLAN_SUMMARY)

  return (
    <>
      <main>
        <section className={styles.hero}>
          <div className={`wrap ${styles.heroGrid}`}>
            <div>
              <span className="tag">Готово за вечер · бесплатно на старте</span>
              <h1>Весь ваш товар — в одной ссылке</h1>
              <p className={styles.lead}>
                Больше не нужно пересылать фото по одному в переписке. Загрузите товары, разложите
                по категориям и отправляйте покупателю ссылку, где сразу видно всё и с ценами. Сайт
                делать не нужно, дизайнер не нужен.
              </p>
              <div className={styles.heroCta}>
                <a className="btn btn--primary" href="/app/register">
                  Создать бесплатно
                </a>
                {/* Ссылки на живую витрину-пример нет: демо-магазин из cmd/seed
                    получает случайный slug. Ведём на разбор «как это работает». */}
                <a className="btn btn--ghost" href="#how">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <path d="M15 3h6v6" />
                    <path d="M10 14 21 3" />
                  </svg>
                  Посмотреть, как это работает
                </a>
              </div>
            </div>

            <div className={styles.peek} aria-hidden="true">
              <div className={styles.peekBar} />
              <div className={styles.peekTabs}>
                <b>Главная</b>
                <span>Альбомы</span>
                <span>Категории</span>
                <span>Контакты</span>
              </div>
              <div className={styles.peekGrid}>
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className={styles.peekCell} />
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="how">
          <div className="wrap">
            <div className="section__head">
              <h2>Как это работает</h2>
              <p>Две минуты: весь путь от первой фотографии до готовой витрины.</p>
            </div>
            {/* Заглушка: видео-гайд ещё не записан. */}
            <div className={styles.video} aria-hidden="true">
              <span className={styles.videoPlay}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </span>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section__head">
              <h2>Что вы получаете</h2>
            </div>
            <div className={styles.grid2}>
              {FEATURES.map((f) => (
                <article key={f.title} className={`card ${styles.feature}`}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="1.8" strokeLinecap="round">
                    {f.icon}
                  </svg>
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section__head">
              <h2>Три шага до первой ссылки</h2>
            </div>
            <div className={styles.steps}>
              {STEPS.map((step, i) => (
                <div key={step.title} className={styles.step}>
                  <span className={styles.stepNum}>{i + 1}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section__head">
              <h2>Тарифы</h2>
            </div>
            <div className={styles.plans}>
              {shownPlans.map((plan) => (
                <article
                  key={plan.id}
                  className={`card ${plan.featured ? 'card--accent' : ''} ${styles.plan}`}
                >
                  <div className={styles.planText}>
                    <b>{plan.name}</b>
                    <span>{PLAN_SUMMARY[plan.id]}</span>
                  </div>
                  <span className={styles.planPrice}>{formatPrice(plan.price)} ₽</span>
                </article>
              ))}
            </div>
            <p className={`center muted ${styles.plansNote}`}>
              Все тарифы можно попробовать 14 дней без карты ·{' '}
              <a href="/pricing">Сравнить возможности</a>
            </p>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className={styles.final}>
              <h2>Первую витрину можно собрать сегодня</h2>
              <p>Бесплатно, без карты и без ограничений по времени.</p>
              <a className="btn btn--primary" href="/app/register">
                Начать
              </a>
            </div>
          </div>
        </section>
      </main>

      <StickyBar
        title="Бесплатно, без карты"
        note="100 фото на старте"
        action="Создать"
        href="/app/register"
      />
    </>
  )
}

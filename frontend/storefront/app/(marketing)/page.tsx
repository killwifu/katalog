import {
  ChartColumn,
  Check,
  Eye,
  FolderOpen,
  Gift,
  Image as ImageIcon,
  ImagePlus,
  Info,
  LayoutGrid,
  LayoutTemplate,
  Link as LinkIcon,
  Lock,
  MessageCircle,
  Zap,
} from 'lucide-react'
import type { Metadata } from 'next'
import { ChannelIcon } from '@/components/ChannelIcon'
import { CtaBanner, Pill, PlansSection } from '@/components/site/blocks'
import l from '@/components/site/landing.module.css'
import s from './home.module.css'
import { VideoCard } from './VideoCard'

export const metadata: Metadata = {
  title: 'вуад — весь бизнес в одной ссылке',
  description:
    'Соберите товары в витрину с альбомами и категориями — покупатель сам всё посмотрит и напишет вам в мессенджер со ссылкой на нужную вещь.',
}

// Адрес ролика читается при рендере на сервере; страница перестраивается
// раз в 10 минут (ISR), чтобы адрес из env доходил без пересборки образа.
export const revalidate = 600

const HERO_ADV = [
  { icon: LayoutGrid, title: 'Подходит для любого бизнеса', text: 'Одежда, мебель, недвижимость, услуги, ремесло' },
  { icon: MessageCircle, title: 'Заказы в мессенджерах', text: 'Telegram, WhatsApp, VK, MAX и Авито' },
  { icon: Zap, title: 'Без сайта и дизайнера', text: 'Загрузите фото — витрина готова' },
]

const ADVANTAGES = [
  {
    icon: LinkIcon,
    title: 'Одна ссылка вместо сотни фото',
    text: 'Отправьте покупателю ссылку на витрину — он сам пролистает альбомы. Больше не нужно пересылать одни и те же фото в каждый чат.',
  },
  {
    icon: MessageCircle,
    title: 'Заказы приходят в мессенджер',
    text: 'Кнопка «Написать» открывает чат в Telegram, WhatsApp или MAX с готовым текстом и ссылкой на фото. Сразу понятно, о каком товаре речь.',
  },
  {
    icon: FolderOpen,
    title: 'Удобная навигация',
    text: 'Альбомы, категории и подкатегории, поиск по названию и сортировка — покупатель находит нужное за секунды, даже среди тысячи товаров.',
  },
  {
    icon: Lock,
    title: 'Фото под защитой',
    text: 'Водяной знак на фото и пароль на закрытые альбомы — для оптовых цен и постоянных клиентов.',
  },
  {
    icon: ImagePlus,
    title: 'Массовая загрузка',
    text: 'Перетащите сразу сотни фото с компьютера — JPEG, HEIC и PNG до 10 МБ. Порядок и обложку можно поменять в пару кликов.',
  },
  {
    icon: LayoutTemplate,
    title: 'Витрина собирается сама',
    text: 'Главная страница складывается из ваших категорий: разделы, обложки, порядок — без дизайнера и вёрстки. На телефоне витрина так же удобна, как на компьютере.',
  },
]

const ANALYTICS = [
  { icon: Eye, title: 'Просмотры и посетители', text: 'По дням и за любой период' },
  { icon: MessageCircle, title: 'Конверсия в чат', text: 'По каждому мессенджеру и Авито' },
  { icon: ImageIcon, title: 'Топ альбомов и фото', text: 'Что открывают чаще всего' },
  { icon: ChartColumn, title: '30 дней истории', text: 'Любой период внутри месяца' },
]

// Макет витрины на первом экране. Фотографий из макета в репозитории нет —
// обложки нарисованы цветными градиентами в тон снимкам.
const SHOP_ALBUMS: [string, number, string][] = [
  ['Одежда', 48, '#e8b4b0,#c98e8a'],
  ['Искусство', 16, '#c9a27a,#8a5a3c'],
  ['Недвижимость', 12, '#9cc58f,#5f8f5a'],
  ['Торты', 22, '#f1d9c4,#d7a98a'],
  ['Автомобили', 9, '#d9534f,#7a1f1d'],
  ['Ремесло', 27, '#c7d3df,#7d93a8'],
  ['Мебель', 31, '#b9a089,#6f5a48'],
  ['Выпечка', 18, '#e0b26b,#a8692e'],
]
const PHONE_ALBUMS: [string, number, string][] = [
  ['Букеты', 24, '#9fc27c,#c9577a'],
  ['Аксессуары', 35, '#5a5a5a,#1f1f1f'],
  ['Услуги', 14, '#e9c6b2,#b07f66'],
  ['Выпечка', 18, '#d99a4e,#8a4f1d'],
  ['Мебель', 31, '#b9a089,#6f5a48'],
  ['Одежда', 48, '#e8b4b0,#c98e8a'],
]
const CHANNELS = ['telegram', 'whatsapp', 'vk', 'max', 'avito'] as const

function Albums({ list }: { list: [string, number, string][] }) {
  return (
    <div className={s.mAlbums}>
      {list.map(([title, n, g]) => (
        <div key={title}>
          <div className={s.mCover} style={{ background: `linear-gradient(135deg,${g})` }}>
            <span>{n} фото</span>
          </div>
          <b>{title}</b>
        </div>
      ))}
    </div>
  )
}

function ShopHead({ tabs }: { tabs: string[] }) {
  return (
    <>
      <div className={s.mShop}>
        <span className={s.mAva}>В</span>
        <div>
          <b>вуад</b>
          <small>Витрина для любого бизнеса</small>
        </div>
        <span className={s.mCh}>
          {CHANNELS.map((c) => (
            <ChannelIcon key={c} channel={c} size={18} />
          ))}
        </span>
      </div>
      <div className={s.mTabs}>
        {tabs.map((t, i) => (
          <span key={t} className={i === 0 ? s.mTabOn : undefined}>
            {t}
          </span>
        ))}
      </div>
      <div className={s.mHead}>
        <b>Альбомы</b>
        <span>Все 12 →</span>
      </div>
    </>
  )
}

// Обложка ролика: условная доска с карточками, как на кадре макета.
const videoCover = (
  <div className={s.cover} aria-hidden="true">
    <div className={s.board}>
      {[5, 6, 4].map((n, col) => (
        <div key={col} className={s.boardCol}>
          <i />
          {Array.from({ length: n }, (_, i) => (
            <span key={i} style={{ background: ['#7c5cff', '#2bb673', '#f5b83d', '#e5484d', '#2547ce'][(i + col) % 5] }} />
          ))}
        </div>
      ))}
    </div>
  </div>
)

// Линии графика посещаемости (виньетка, не данные).
const VIEWS = [40, 46, 43, 52, 47, 55, 50, 58, 54, 62, 66, 61, 70, 64, 72, 68, 78, 74, 70, 80, 84, 79, 88, 86, 92]
const UNIQUE = [14, 15, 15, 17, 16, 17, 18, 18, 19, 19, 21, 20, 21, 22, 21, 22, 23, 22, 24, 24, 25, 24, 26, 26, 27]
const line = (v: number[]) => v.map((y, i) => `${(i * 480) / (v.length - 1)},${150 - y * 1.4}`).join(' ')
const SHARE: [(typeof CHANNELS)[number], string, number, string][] = [
  ['telegram', 'Telegram', 38, '#2aabee'],
  ['whatsapp', 'WhatsApp', 35, '#25d366'],
  ['vk', 'VK', 13, '#0077ff'],
  ['max', 'MAX', 9, '#7b3ff2'],
  ['avito', 'Авито', 5, '#ff4053'],
]

export default function HomePage() {
  const video = process.env.LANDING_VIDEO_URL ?? ''
  return (
    <main>
      <section className={s.hero}>
        <div className={`${l.in} ${s.heroMain}`}>
          <div className={s.heroText}>
            <h1>Весь бизнес в одной ссылке</h1>
            <p>
              Больше не нужно пересылать каждому покупателю одни и те же фото. Соберите товары в витрину с альбомами и
              категориями — покупатель сам всё посмотрит и напишет вам в мессенджер со ссылкой на нужную вещь.
            </p>
            <div className={s.heroCta}>
              <a className={`auth-out ${l.btn} ${l.btnPrimary} ${l.btnXl}`} href="/app/register?trial=1">
                Создать аккаунт
              </a>
              <a className={`auth-in ${l.btn} ${l.btnPrimary} ${l.btnXl}`} href="/app/">
                Перейти в кабинет
              </a>
              <div className={`auth-out ${s.trial}`}>
                <span className={s.trialIc}>
                  <Gift size={16} />
                </span>
                <div>
                  <b>7 дней тарифа «Про» бесплатно</b>
                  <small>Без привязки карты</small>
                </div>
              </div>
            </div>
          </div>

          <div className={s.mock} aria-hidden="true">
            <div className={s.browser}>
              <div className={s.dots}>
                <i />
                <i />
                <i />
              </div>
              <div className={s.browserBody}>
                <ShopHead tabs={['Главная', 'Альбомы', 'Категории', 'Контакты']} />
                <Albums list={SHOP_ALBUMS} />
              </div>
            </div>
            <div className={s.phone}>
              <div className={s.phoneScreen}>
                <ShopHead tabs={['Главная', 'Альбомы', 'Категории']} />
                <Albums list={PHONE_ALBUMS} />
              </div>
            </div>
          </div>
        </div>

        <div className={`${l.in} ${s.heroAdv}`}>
          {HERO_ADV.map(({ icon: Icon, title, text }) => (
            <div key={title} className={s.heroAdvCard}>
              <span className={s.tile}>
                <Icon size={22} color="#fff" />
              </span>
              <div>
                <b>{title}</b>
                <p>{text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={s.videoSec} id="how">
        <div className={l.in}>
          <h2 className={l.h2}>Как это работает</h2>
          <p className={s.videoLead}>
            Короткое видео о привычных сложностях продавцов — фото в переписках, повторяющиеся вопросы, потерянные
            заказы — и о том, как наш сервис помогает с ними справиться.
          </p>
          <div className={s.videoCard}>
            <VideoCard src={video} cover={videoCover} />
          </div>
        </div>
      </section>

      <section className={s.advSec}>
        <div className={`${l.in} ${l.center}`}>
          <Pill icon={<Check size={16} strokeWidth={3} />}>Преимущества</Pill>
          <h2 className={l.h2}>Экономьте ресурсы вместе с ВУАД</h2>
          <div className={s.advGrid}>
            {ADVANTAGES.map(({ icon: Icon, title, text }) => (
              <article key={title} className={s.advCard}>
                <span className={s.iconBox}>
                  <Icon size={22} color="var(--brand)" />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className={s.anSec}>
        <div className={l.in}>
          <div className={s.anPanel}>
            <div className={s.anText}>
              <Pill icon={<ChartColumn size={15} strokeWidth={2.5} />}>Аналитика</Pill>
              <h2>Цифры перед глазами</h2>
              <p className={s.anLead}>
                Видно, сколько людей заходит на витрину, что смотрят и куда пишут. Понятно, какие товары тянут
                продажи, а какие пора убрать.
              </p>
              <div className={s.anFeats}>
                {ANALYTICS.map(({ icon: Icon, title, text }) => (
                  <div key={title} className={s.anFeat}>
                    <span className={s.iconSm}>
                      <Icon size={16} color="var(--brand)" />
                    </span>
                    <b>{title}</b>
                    <small>{text}</small>
                  </div>
                ))}
              </div>
              <p className={s.anNote}>
                <Info size={16} />
                На тарифах «Стандарт», «Про» и «Бизнес»
              </p>
            </div>

            <div className={s.anVisual} aria-hidden="true">
              <div className={`${s.kpi} ${s.kpi1}`}>
                <small>Просмотры</small>
                <b>
                  14 860 <em>↑ 12%</em>
                </b>
                <small className={s.kpiSub}>за 30 дней</small>
              </div>
              <div className={`${s.kpi} ${s.kpi2}`}>
                <small>Конверсия в чат</small>
                <b>
                  1 046 <em>↑ 8%</em>
                </b>
                <small className={s.kpiSub}>≈ 35 в день</small>
              </div>
              <div className={s.chart}>
                <div className={s.chartHead}>
                  <div>
                    <b>Посещаемость профиля</b>
                    <small>Последние 30 дней</small>
                  </div>
                  <span className={s.legend}>
                    <i style={{ background: '#2547ce' }} /> Просмотры <i style={{ background: '#f08a3c' }} /> Уникальные
                  </span>
                </div>
                <svg viewBox="0 0 480 150" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="anfill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#2547ce" stopOpacity=".18" />
                      <stop offset="1" stopColor="#2547ce" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  {[30, 70, 110].map((y) => (
                    <path key={y} d={`M0 ${y}H480`} stroke="#eeede9" />
                  ))}
                  <polygon points={`0,150 ${line(VIEWS)} 480,150`} fill="url(#anfill)" />
                  <polyline points={line(VIEWS)} fill="none" stroke="#2547ce" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                  <polyline points={line(UNIQUE)} fill="none" stroke="#f08a3c" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                  <path d="M330 0V150" stroke="#cfccc4" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                </svg>
                <span className={s.tip}>
                  <small>Вт, 20 октября</small>
                  <b>612 просмотров</b>
                </span>
              </div>
              <div className={s.share}>
                <b>Куда переходят покупатели</b>
                {SHARE.map(([ch, name, pct, color]) => (
                  <div key={ch} className={s.shareRow}>
                    <ChannelIcon channel={ch} size={16} />
                    <span>{name}</span>
                    <i>
                      <i style={{ width: `${pct * 2.5}%`, background: color }} />
                    </i>
                    <b>{pct}%</b>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <PlansSection compareLink />
      <CtaBanner />
    </main>
  )
}

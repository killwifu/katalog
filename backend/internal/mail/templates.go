package mail

import (
	"fmt"
	"strings"
)

// Шаблоны цепочки писем. Тон задан макетами и продуктовыми решениями kit,
// и он не косметический:
//
//   - письмо о неоплате показывает цифры продавца, а не расписывает тариф:
//     сначала доказательство ценности, потом цена;
//   - письмо о скрытии витрины не наказывает, а сообщает, что фотографии
//     целы. Продавец, не заплативший из-за нехватки денег, скорее вернётся,
//     если не чувствует себя брошенным.
//
// Тексты простые, без HTML: письма уходят через net/smtp как text/plain,
// а вёрстку писем заводить ради пяти шаблонов рано.

// Template — готовое письмо: тема и текст.
type Template struct {
	Subject string
	Text    string
}

func shopURL(siteURL, slug string) string {
	return strings.TrimRight(siteURL, "/") + "/" + slug
}

// GraceStarted — оплата не прошла, загрузка приостановлена, витрина ещё
// работает. Цифры важнее описания тарифа: они отвечают на вопрос
// «работает ли витрина» и оправдывают подписку.
func GraceStarted(shopName, siteURL, slug string, views, leads int64, graceDays int) Template {
	var b strings.Builder
	fmt.Fprintf(&b, "Здравствуйте!\n\nОплата за «%s» не прошла.\n\n", shopName)
	if views > 0 || leads > 0 {
		fmt.Fprintf(&b, "За последний месяц каталог посмотрели %d раз", views)
		if leads > 0 {
			fmt.Fprintf(&b, ", и %d раз покупатели написали вам в мессенджер", leads)
		}
		b.WriteString(".\n\n")
	}
	fmt.Fprintf(&b, "Витрина продолжает работать ещё %d дней — покупатели ничего не заметят.\n", graceDays)
	b.WriteString("Загрузка новых фотографий пока приостановлена.\n\n")
	fmt.Fprintf(&b, "Ваш каталог: %s\nПродлить подписку: %s/app/billing\n",
		shopURL(siteURL, slug), strings.TrimRight(siteURL, "/"))
	return Template{
		Subject: fmt.Sprintf("Оплата за «%s» не прошла", shopName),
		Text:    b.String(),
	}
}

// ShopHidden — витрина скрыта. Письмо намеренно не упрекает: его задача —
// снять страх потери фотографий, из-за которого продавец не возвращается.
func ShopHidden(shopName, siteURL, slug string, keepMonths int) Template {
	var b strings.Builder
	fmt.Fprintf(&b, "Здравствуйте!\n\nВитрина «%s» временно скрыта — подписка не продлена.\n\n", shopName)
	fmt.Fprintf(&b, "Фотографии целы. Мы храним их %d месяца и ничего не удаляем.\n", keepMonths)
	b.WriteString("Как только подписка возобновится, каталог вернётся целиком: альбомы, разделы, ссылки.\n")
	b.WriteString("Ссылки, которые вы уже разослали, продолжат работать — покупатель увидит ваши контакты и сможет написать.\n\n")
	fmt.Fprintf(&b, "Вернуть витрину: %s/app/billing\n", strings.TrimRight(siteURL, "/"))
	return Template{
		Subject: fmt.Sprintf("Витрина «%s» скрыта, фотографии сохранены", shopName),
		Text:    b.String(),
	}
}

// PaymentSucceeded — оплата прошла.
func PaymentSucceeded(shopName, plan string, amountKopecks int64, paidUntil string) Template {
	return Template{
		Subject: fmt.Sprintf("Оплата за «%s» получена", shopName),
		Text: fmt.Sprintf(
			"Здравствуйте!\n\nОплата получена: тариф «%s», %s ₽.\nПодписка действует до %s.\n\nСпасибо!\n",
			plan, formatRubles(amountKopecks), paidUntil),
	}
}

// ChargeFailed — автосписание не прошло. Указываем, что делать, а не то,
// что случилось: продавцу нужно действие, а не диагноз.
func ChargeFailed(shopName, siteURL string, graceDays int) Template {
	return Template{
		Subject: fmt.Sprintf("Не удалось списать оплату за «%s»", shopName),
		Text: fmt.Sprintf(
			"Здравствуйте!\n\nАвтосписание за «%s» не прошло — чаще всего дело в истёкшей карте или лимите банка.\n\n"+
				"Витрина работает ещё %d дней. Обновить способ оплаты: %s/app/billing\n",
			shopName, graceDays, strings.TrimRight(siteURL, "/")),
	}
}

// QuotaWarning — место заканчивается. Отправляется один раз при переходе
// через порог, а не на каждую загрузку.
func QuotaWarning(shopName, siteURL string, usedBytes, maxBytes int64) Template {
	percent := int64(0)
	if maxBytes > 0 {
		percent = usedBytes * 100 / maxBytes
	}
	return Template{
		Subject: fmt.Sprintf("В «%s» заканчивается место", shopName),
		Text: fmt.Sprintf(
			"Здравствуйте!\n\nВ каталоге «%s» занято %d%% места (%s из %s).\n\n"+
				"Когда место закончится, загрузка новых фотографий остановится — витрина продолжит работать.\n"+
				"Расширить хранилище: %s/app/billing\n",
			shopName, percent, formatMB(usedBytes), formatMB(maxBytes), strings.TrimRight(siteURL, "/")),
	}
}

func formatRubles(kopecks int64) string {
	return fmt.Sprintf("%d", kopecks/100)
}

func formatMB(bytes int64) string {
	const mb = 1024 * 1024
	if bytes >= 1024*mb {
		return fmt.Sprintf("%.1f ГБ", float64(bytes)/float64(1024*mb))
	}
	return fmt.Sprintf("%d МБ", bytes/mb)
}

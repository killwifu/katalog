package mail

import (
	"fmt"
	"strings"
)

// Шаблоны цепочки писем. Тон задан макетами и продуктовыми решениями kit,
// и он не косметический:
//
//   - письмо об окончании тарифа не наказывает, а сообщает, что витрина
//     работает и фотографии целы.
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

// PlanName — название тарифа для писем и описаний платежей.
func PlanName(plan string) string {
	switch plan {
	case "free":
		return "Бесплатный"
	case "standard":
		return "Стандарт"
	case "pro":
		return "Про"
	case "business":
		return "Бизнес"
	}
	return plan
}

// PlanEnded — платный тариф (или пробный период) закончился, аккаунт на
// Бесплатном. Письмо не пугает: витрина работает, фотографии целы.
func PlanEnded(shopName, siteURL, slug string) Template {
	var b strings.Builder
	fmt.Fprintf(&b, "Здравствуйте!\n\nПлатный тариф «%s» закончился — аккаунт перешёл на «Бесплатный».\n\n", shopName)
	b.WriteString("Витрина продолжает работать, все фотографии на месте.\n")
	b.WriteString("Если фото больше лимита «Бесплатного», новые загрузить не получится, пока не удалите лишние.\n")
	b.WriteString("Аналитика недоступна, пароли на альбомах сохранятся, но изменить или снять их нельзя.\n\n")
	fmt.Fprintf(&b, "Ваш каталог: %s\nПродлить тариф: %s/app/billing\n",
		shopURL(siteURL, slug), strings.TrimRight(siteURL, "/"))
	return Template{
		Subject: fmt.Sprintf("Тариф «%s» перешёл на Бесплатный", shopName),
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
func ChargeFailed(shopName, siteURL, paidUntil string) Template {
	return Template{
		Subject: fmt.Sprintf("Не удалось списать оплату за «%s»", shopName),
		Text: fmt.Sprintf(
			"Здравствуйте!\n\nАвтосписание за «%s» не прошло — чаще всего дело в истёкшей карте или лимите банка.\n\n"+
				"Повторно списывать не будем: тариф действует до %s, потом аккаунт перейдёт на «Бесплатный». "+
				"Витрина продолжит работать.\nОплатить тариф вручную: %s/app/billing\n",
			shopName, paidUntil, strings.TrimRight(siteURL, "/")),
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

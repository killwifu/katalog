package mail

import (
	"fmt"
	"html"
	"net/url"
	"strings"
	"time"
)

// Шаблоны писем продавцу (макет 09 · «Письма»): логотип «вуад», белая
// карточка с заголовком, текстом и кнопкой, мелкая приписка со ссылкой
// и футер. Каждое письмо уходит в двух видах — HTML и text/plain из тех же
// строк, чтобы они не разъезжались.
//
// Тон задан макетами и продуктовыми решениями kit, и он не косметический:
// письмо об окончании тарифа не наказывает, а сообщает, что витрина
// работает и фотографии целы.

// Template — готовое письмо: тема, текст и HTML.
type Template struct {
	Subject string
	Text    string
	HTML    string
}

// letter — содержимое письма. В абзацах **так** выделяется жирным
// (в HTML — <b>, в тексте разметка просто убирается).
type letter struct {
	subject string
	title   string
	paras   []string
	button  string // текст кнопки; пусто — без кнопки
	url     string // ссылка кнопки
	note    string // мелкий текст под кнопкой
	showURL bool   // показать ссылку текстом под note («если кнопка не работает»)
	footer  string // приписка над копирайтом
}

func (l letter) render(siteURL string) Template {
	host := siteURL
	if u, err := url.Parse(siteURL); err == nil && u.Host != "" {
		host = u.Host
	}
	copyright := fmt.Sprintf("© %d вуад · %s", time.Now().Year(), host)

	// text/plain
	var t strings.Builder
	t.WriteString(l.title + "\n\n")
	for _, p := range l.paras {
		t.WriteString(strings.ReplaceAll(p, "**", "") + "\n\n")
	}
	// В тексте кнопки нет: при showURL ссылка идёт под припиской
	// («скопируйте ссылку в браузер:»), иначе — строкой «Кнопка: ссылка».
	if l.button != "" && !l.showURL {
		t.WriteString(l.button + ": " + l.url + "\n\n")
	}
	if l.note != "" {
		t.WriteString(l.note + "\n")
	}
	if l.showURL {
		t.WriteString(l.url + "\n")
	}
	if l.note != "" || l.showURL {
		t.WriteString("\n")
	}
	if l.footer != "" {
		t.WriteString(l.footer + "\n")
	}
	t.WriteString(copyright + "\n")

	// HTML: таблицы и инлайн-стили — так письмо одинаково выглядит
	// в почтовых клиентах, которые режут <style> и flex.
	var h strings.Builder
	h.WriteString(`<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>` + html.EscapeString(l.subject) + `</title>` +
		`<style>@media (max-width:480px){.card{padding:24px!important}.btn{display:block!important;text-align:center!important}}</style>` +
		`</head><body style="margin:0;padding:0;background:#F6F5F3;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">` +
		`<tr><td align="center" style="padding:40px 12px;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">` +
		`<tr><td style="padding:0 0 16px 0;font-size:24px;font-weight:700;color:#1A1A18;">вуад</td></tr>` +
		`<tr><td class="card" style="background:#FFFFFF;border-radius:20px;padding:40px;">`)
	h.WriteString(`<h1 style="margin:0 0 24px 0;font-size:28px;line-height:34px;font-weight:700;color:#1A1A18;">` + html.EscapeString(l.title) + `</h1>`)
	for _, p := range l.paras {
		h.WriteString(`<p style="margin:0 0 24px 0;font-size:16px;line-height:24px;color:#62615C;">` + boldHTML(p) + `</p>`)
	}
	if l.button != "" {
		gap := "32px"
		if l.note == "" && !l.showURL {
			gap = "0"
		}
		h.WriteString(`<p style="margin:0 0 ` + gap + ` 0;"><a class="btn" href="` + html.EscapeString(l.url) + `" style="display:inline-block;background:#2547CE;color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:600;line-height:20px;padding:14px 28px;border-radius:999px;">` + html.EscapeString(l.button) + `</a></p>`)
	}
	if l.note != "" {
		h.WriteString(`<p style="margin:0;font-size:14px;line-height:20px;color:#6E6D67;">` + html.EscapeString(l.note) + `</p>`)
	}
	if l.showURL {
		h.WriteString(`<p style="margin:4px 0 0 0;font-size:14px;line-height:20px;word-break:break-all;"><a href="` + html.EscapeString(l.url) + `" style="color:#2547CE;text-decoration:none;">` + html.EscapeString(l.url) + `</a></p>`)
	}
	h.WriteString(`</td></tr><tr><td style="padding:24px 40px 0 40px;font-size:13px;line-height:19px;color:#6E6D67;">`)
	if l.footer != "" {
		h.WriteString(`<p style="margin:0 0 8px 0;">` + html.EscapeString(l.footer) + `</p>`)
	}
	h.WriteString(`<p style="margin:0;">` + html.EscapeString(copyright) + `</p>`)
	h.WriteString(`</td></tr></table></td></tr></table></body></html>`)

	return Template{Subject: l.subject, Text: t.String(), HTML: h.String()}
}

// boldHTML экранирует абзац и превращает **…** в <b>.
func boldHTML(p string) string {
	parts := strings.Split(p, "**")
	var b strings.Builder
	for i, part := range parts {
		if i%2 == 1 {
			b.WriteString(`<b style="font-weight:500;color:#1A1A18;">` + html.EscapeString(part) + `</b>`)
		} else {
			b.WriteString(html.EscapeString(part))
		}
	}
	return b.String()
}

// VerifyEmail — подтверждение почты после регистрации (макет 09).
func VerifyEmail(siteURL, email, link string) Template {
	return letter{
		subject: "Подтвердите почту",
		title:   "Подтвердите почту",
		paras: []string{
			"Вы зарегистрировались в ВУАД с почтой **" + email + "**. Подтвердите её — и перейдём к созданию витрины.",
		},
		button:  "Подтвердить почту",
		url:     link,
		note:    "Ссылка действует 24 часа. Если кнопка не работает, скопируйте ссылку в браузер:",
		showURL: true,
		footer:  "Если вы не регистрировались в ВУАД, просто удалите это письмо.",
	}.render(siteURL)
}

// ConfirmNewEmail — подтверждение новой почты из «Настроек» (макет 09).
func ConfirmNewEmail(siteURL, shopName, link string) Template {
	who := "вашего аккаунта"
	if shopName != "" {
		who = "аккаунта **" + shopName + "**"
	}
	return letter{
		subject: "Подтвердите новую почту",
		title:   "Подтвердите новую почту",
		paras: []string{
			"Эту почту указали в настройках " + who + " в ВУАД. Подтвердите её, чтобы получать на неё чеки и уведомления.",
		},
		button:  "Подтвердить почту",
		url:     link,
		note:    "Ссылка действует 24 часа. Если кнопка не работает, скопируйте ссылку в браузер:",
		showURL: true,
		footer:  "Если это были не вы, просто удалите письмо — без подтверждения почта не сохранится.",
	}.render(siteURL)
}

// ResetPassword — восстановление пароля (макет 09).
func ResetPassword(siteURL, email, link string) Template {
	return letter{
		subject: "Восстановление пароля",
		title:   "Восстановление пароля",
		paras: []string{
			"Вы запросили смену пароля для аккаунта **" + email + "**. Нажмите кнопку, чтобы задать новый.",
		},
		button:  "Задать новый пароль",
		url:     link,
		note:    "Ссылка действует 1 час и срабатывает один раз. Если кнопка не работает, скопируйте ссылку в браузер:",
		showURL: true,
		footer:  "Если вы не запрашивали смену пароля, просто удалите письмо — пароль останется прежним.",
	}.render(siteURL)
}

func shopURL(siteURL, slug string) string {
	return strings.TrimRight(siteURL, "/") + "/" + slug
}

func billingURL(siteURL string) string {
	return strings.TrimRight(siteURL, "/") + "/app/billing"
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
	return letter{
		subject: fmt.Sprintf("Тариф «%s» перешёл на Бесплатный", shopName),
		title:   "Аккаунт перешёл на «Бесплатный»",
		paras: []string{
			fmt.Sprintf("Платный тариф **%s** закончился — аккаунт перешёл на «Бесплатный».", shopName),
			"Витрина продолжает работать, все фотографии на месте. " +
				"Если фото больше лимита «Бесплатного», новые загрузить не получится, пока не удалите лишние. " +
				"Аналитика недоступна, пароли на альбомах сохранятся, но изменить или снять их нельзя.",
			"Ваш каталог: " + shopURL(siteURL, slug),
		},
		button: "Продлить тариф",
		url:    billingURL(siteURL),
	}.render(siteURL)
}

// PaymentSucceeded — оплата прошла.
func PaymentSucceeded(siteURL, shopName, plan string, amountKopecks int64, paidUntil string) Template {
	return letter{
		subject: fmt.Sprintf("Оплата за «%s» получена", shopName),
		title:   "Оплата получена",
		paras: []string{
			fmt.Sprintf("Оплата получена: тариф **%s**, **%s ₽**. Подписка действует до **%s**.",
				plan, formatRubles(amountKopecks), paidUntil),
			"Спасибо!",
		},
		button: "Открыть подписку",
		url:    billingURL(siteURL),
	}.render(siteURL)
}

// ChargeFailed — автосписание не прошло. Указываем, что делать, а не то,
// что случилось: продавцу нужно действие, а не диагноз.
func ChargeFailed(shopName, siteURL, paidUntil string) Template {
	return letter{
		subject: fmt.Sprintf("Не удалось списать оплату за «%s»", shopName),
		title:   "Не удалось списать оплату",
		paras: []string{
			fmt.Sprintf("Автосписание за **%s** не прошло — чаще всего дело в истёкшей карте или лимите банка.", shopName),
			fmt.Sprintf("Повторно списывать не будем: тариф действует до **%s**, потом аккаунт перейдёт на «Бесплатный». "+
				"Витрина продолжит работать.", paidUntil),
		},
		button:  "Оплатить тариф вручную",
		url:     billingURL(siteURL),
		note:    "Если кнопка не работает, скопируйте ссылку в браузер:",
		showURL: true,
	}.render(siteURL)
}

// QuotaWarning — место заканчивается. Отправляется один раз при переходе
// через порог, а не на каждую загрузку.
func QuotaWarning(shopName, siteURL string, usedBytes, maxBytes int64) Template {
	percent := int64(0)
	if maxBytes > 0 {
		percent = usedBytes * 100 / maxBytes
	}
	return letter{
		subject: fmt.Sprintf("В «%s» заканчивается место", shopName),
		title:   "Заканчивается место",
		paras: []string{
			fmt.Sprintf("В каталоге **%s** занято **%d%%** места (%s из %s).",
				shopName, percent, formatMB(usedBytes), formatMB(maxBytes)),
			"Когда место закончится, загрузка новых фотографий остановится — витрина продолжит работать.",
		},
		button: "Расширить хранилище",
		url:    billingURL(siteURL),
	}.render(siteURL)
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

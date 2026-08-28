package api

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// Полную ссылку продавец вставить может — у MAX это обычный сценарий, — но
// только на сам мессенджер. Иначе кнопка «VK» на витрине уводит куда угодно:
// своих ссылок в каталоге продавцу больше поставить негде, и поле контактов
// становится готовым каналом для фишинга под именем площадки.
var contactHosts = map[string][]string{
	"vk":  {"vk.me", "vk.com", "m.vk.com"},
	"max": {"max.ru", "m.max.ru"},
}

// maxContactValue — ник или ссылка; всё длиннее — мусор либо попытка
// раздуть публичную выдачу магазина.
const maxContactValue = 200

// maxWatermarkText — знак должен помещаться поперёк кадра; всё длиннее
// нечитаемо и только тормозит отрисовку.
const maxWatermarkText = 64

// validateSettings проверяет настройки магазина. Пока это только водяной
// знак — единственное поле settings, которое доезжает до обработки фото.
func validateSettings(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var settings struct {
		Watermark struct {
			Text    string  `json:"text"`
			Opacity float64 `json:"opacity"`
		} `json:"watermark"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		return "settings must be an object"
	}
	wm := settings.Watermark
	if len([]rune(wm.Text)) > maxWatermarkText {
		return fmt.Sprintf("watermark.text must be at most %d characters", maxWatermarkText)
	}
	if strings.ContainsAny(wm.Text, "\n\r") {
		return "watermark.text must be a single line"
	}
	if wm.Opacity < 0 || wm.Opacity > 1 {
		return "watermark.opacity must be between 0 and 1"
	}
	return ""
}

// validateContacts проверяет каналы связи магазина. Пустая строка означает
// «канал не заполнен» и допустима: так продавец его убирает.
func validateContacts(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var contacts map[string]string
	if err := json.Unmarshal(raw, &contacts); err != nil {
		return "contacts must be an object of channel -> string"
	}
	for channel, value := range contacts {
		v := strings.TrimSpace(value)
		if v == "" {
			continue
		}
		if len(v) > maxContactValue {
			return fmt.Sprintf("%s: value must be at most %d characters", channel, maxContactValue)
		}
		if strings.ContainsAny(v, "\n\r") {
			return fmt.Sprintf("%s: value must be a single line", channel)
		}
		hosts, restricted := contactHosts[channel]
		if !restricted {
			continue
		}
		lower := strings.ToLower(v)
		if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
			continue // обычный ник
		}
		u, err := url.Parse(v)
		if err != nil {
			return fmt.Sprintf("%s: invalid link", channel)
		}
		host := strings.ToLower(u.Hostname())
		if !contains(hosts, host) {
			return fmt.Sprintf("%s: link must point to %s", channel, strings.Join(hosts, ", "))
		}
	}
	return ""
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

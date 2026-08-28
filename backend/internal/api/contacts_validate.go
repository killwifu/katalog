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

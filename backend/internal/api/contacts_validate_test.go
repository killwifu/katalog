package api

import (
	"encoding/json"
	"testing"
)

func TestValidateContacts(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"ники", `{"telegram":"shop","whatsapp":"79990000000","vk":"shop","max":"shop"}`, false},
		{"пустые значения — снятие канала", `{"telegram":"","vk":""}`, false},
		{"полная ссылка на свой хост", `{"max":"https://max.ru/shop"}`, false},
		{"vk.com тоже свой", `{"vk":"https://vk.com/shop"}`, false},

		{"чужой хост в vk", `{"vk":"https://evil.example/phish"}`, true},
		{"чужой хост в max", `{"max":"http://attacker.tld"}`, true},
		{"похожий, но чужой хост", `{"vk":"https://vk.me.evil.example/x"}`, true},
		{"слишком длинное значение", `{"telegram":"` + str(201) + `"}`, true},
		{"перенос строки", `{"telegram":"shop\nother"}`, true},
		{"не объект строк", `{"telegram":123}`, true},

		// Телеграм и whatsapp ссылками не задаются — там всегда ник или номер,
		// и «https://...» просто станет частью ника, никуда не уводя.
		{"ссылка в telegram остаётся ником", `{"telegram":"https://evil.example"}`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := validateContacts(json.RawMessage(tt.raw))
			if (got != "") != tt.wantErr {
				t.Fatalf("validateContacts(%s) = %q, wantErr %v", tt.raw, got, tt.wantErr)
			}
		})
	}
}

func str(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'a'
	}
	return string(b)
}

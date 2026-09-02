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

		// Номер WhatsApp: витрина строит wa.me/<цифры>, поэтому всё, что
		// не превращается в номер, даёт ссылку без получателя.
		{"whatsapp ником", `{"whatsapp":"@myshop"}`, true},
		{"whatsapp почтой", `{"whatsapp":"shop@example.com"}`, true},
		{"whatsapp слишком короткий", `{"whatsapp":"12345"}`, true},
		{"whatsapp с российской восьмёркой", `{"whatsapp":"8 999 123-45-67"}`, true},
		{"whatsapp международный", `{"whatsapp":"79991234567"}`, false},
		{"whatsapp с разделителями", `{"whatsapp":"+7 999 123-45-67"}`, false},

		// Телеграм и whatsapp ссылками не задаются — там всегда ник или номер,
		// и «https://...» просто станет частью ника, никуда не уводя.
		{"ссылка в telegram остаётся ником", `{"telegram":"https://evil.example"}`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			code, msg := validateContacts(json.RawMessage(tt.raw))
			if (code != "") != tt.wantErr {
				t.Fatalf("validateContacts(%s) = %q (%q), wantErr %v", tt.raw, code, msg, tt.wantErr)
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

func TestValidateSettings(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"знак с амперсандом", `{"watermark":{"enabled":true,"text":"Обувь & сумки","opacity":0.5}}`, false},
		{"пустые настройки", `{}`, false},
		{"без водяного знака", `{"msg_template":"привет"}`, false},

		{"слишком длинный знак", `{"watermark":{"text":"` + str(65) + `"}}`, true},
		{"перенос строки в знаке", `{"watermark":{"text":"верх\nниз"}}`, true},
		{"прозрачность больше единицы", `{"watermark":{"text":"x","opacity":5}}`, true},
		{"отрицательная прозрачность", `{"watermark":{"text":"x","opacity":-1}}`, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := validateSettings(json.RawMessage(tt.raw))
			if (got != "") != tt.wantErr {
				t.Fatalf("validateSettings(%s) = %q, wantErr %v", tt.raw, got, tt.wantErr)
			}
		})
	}
}

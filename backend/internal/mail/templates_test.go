package mail

import (
	"strings"
	"testing"
)

// Тон писем — продуктовое решение, а не косметика, поэтому проверяем
// именно его: письмо об окончании тарифа не пугает потерей фотографий.
func TestPlanEndedDoesNotPunish(t *testing.T) {
	tpl := PlanEnded("Seoul Wear", "https://katalog.ru", "seoul")

	for _, want := range []string{"Витрина продолжает работать", "Seoul Wear", "https://katalog.ru/seoul", "/app/billing"} {
		if !strings.Contains(tpl.Text, want) {
			t.Errorf("письмо не содержит %q:\n%s", want, tpl.Text)
		}
	}
	for _, bad := range []string{"заблокирован", "нарушен", "удалены", "долг", "скрыта"} {
		if strings.Contains(strings.ToLower(tpl.Text+tpl.Subject), bad) {
			t.Errorf("письмо не должно содержать %q:\n%s", bad, tpl.Text)
		}
	}
}

func TestQuotaWarningPercent(t *testing.T) {
	tpl := QuotaWarning("Shop", "https://katalog.ru", 950*1024*1024, 1024*1024*1024)
	if !strings.Contains(tpl.Text, "92%") {
		t.Errorf("процент посчитан неверно:\n%s", tpl.Text)
	}
	// Витрина продолжает работать — это важно сказать, иначе продавец
	// решит, что каталог уже недоступен покупателям.
	if !strings.Contains(tpl.Text, "витрина продолжит работать") {
		t.Errorf("не сказано, что витрина работает:\n%s", tpl.Text)
	}
}

func TestChargeFailedTellsWhatToDo(t *testing.T) {
	tpl := ChargeFailed("Shop", "https://katalog.ru", "27.10.2026")
	if !strings.Contains(tpl.Text, "/app/billing") {
		t.Error("нет ссылки на оплату")
	}
	if !strings.Contains(tpl.Text, "27.10.2026") {
		t.Error("не сказано, до какого числа действует тариф")
	}
}

func TestPaymentSucceededFormatsAmount(t *testing.T) {
	tpl := PaymentSucceeded("https://katalog.ru", "Shop", "pro", 99000, "01.09.2026")
	if !strings.Contains(tpl.Text, "990 ₽") {
		t.Errorf("копейки не переведены в рубли:\n%s", tpl.Text)
	}
	if !strings.Contains(tpl.Text, "01.09.2026") {
		t.Error("нет даты окончания подписки")
	}
}

// HTML-версия экранирует пользовательские данные (название магазина, почту)
// и несёт ту же ссылку, что и текст.
func TestLetterHTMLEscapesAndLinks(t *testing.T) {
	tpl := ConfirmNewEmail("https://vuad.example", `<script>x</script>`, "https://vuad.example/app/confirm-email?token=abc")
	if strings.Contains(tpl.HTML, "<script>x") {
		t.Error("название магазина не экранировано в HTML")
	}
	for _, s := range []string{tpl.HTML, tpl.Text} {
		if !strings.Contains(s, "token=abc") {
			t.Errorf("нет ссылки подтверждения:\n%s", s)
		}
		if !strings.Contains(s, "vuad.example") || !strings.Contains(s, "© ") {
			t.Errorf("нет футера с доменом из конфига:\n%s", s)
		}
	}
	if strings.Contains(tpl.Text, "**") {
		t.Error("разметка жирного осталась в text/plain")
	}
}

func TestBuildRFC822Multipart(t *testing.T) {
	raw := string(buildRFC822(`"ВУАД" <noreply@vuad.example>`, Message{To: "a@b.ru", Subject: "Тема", Text: "t", HTML: "<p>h</p>"}))
	for _, want := range []string{"multipart/alternative", "text/plain; charset=utf-8", "text/html; charset=utf-8", "--" + mimeBoundary + "--"} {
		if !strings.Contains(raw, want) {
			t.Errorf("нет %q в письме:\n%s", want, raw)
		}
	}
	if strings.Contains(string(buildRFC822("x", Message{Text: "t"})), "multipart") {
		t.Error("письмо без HTML должно остаться text/plain")
	}
}

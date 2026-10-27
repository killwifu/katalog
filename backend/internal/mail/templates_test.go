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
	tpl := PaymentSucceeded("Shop", "pro", 99000, "01.09.2026")
	if !strings.Contains(tpl.Text, "990 ₽") {
		t.Errorf("копейки не переведены в рубли:\n%s", tpl.Text)
	}
	if !strings.Contains(tpl.Text, "01.09.2026") {
		t.Error("нет даты окончания подписки")
	}
}

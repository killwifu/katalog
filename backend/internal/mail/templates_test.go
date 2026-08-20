package mail

import (
	"strings"
	"testing"
)

// Тон писем — продуктовое решение kit, а не косметика, поэтому проверяем
// именно его: что письмо о неоплате показывает цифры продавца, а письмо
// о скрытии витрины не пугает потерей фотографий.
func TestGraceStartedShowsSellerNumbers(t *testing.T) {
	tpl := GraceStarted("Seoul Wear", "https://katalog.ru", "seoul", 1240, 37, 7)

	for _, want := range []string{"1240", "37", "Seoul Wear", "https://katalog.ru/seoul"} {
		if !strings.Contains(tpl.Text, want) {
			t.Errorf("письмо о неоплате не содержит %q:\n%s", want, tpl.Text)
		}
	}
	// Сначала доказательство ценности, потом цена: цифры должны идти
	// раньше ссылки на тарифы.
	if strings.Index(tpl.Text, "1240") > strings.Index(tpl.Text, "/app/billing") {
		t.Error("цифры продавца должны идти до ссылки на оплату")
	}
}

func TestGraceStartedWithoutNumbers(t *testing.T) {
	tpl := GraceStarted("Пустой", "https://katalog.ru", "empty", 0, 0, 7)
	// Нулевые цифры не показываем: «вас посмотрели 0 раз» — плохой аргумент
	// в письме, которое должно вернуть продавца.
	if strings.Contains(tpl.Text, "0 раз") {
		t.Errorf("нулевые цифры не должны попадать в письмо:\n%s", tpl.Text)
	}
	if !strings.Contains(tpl.Text, "Пустой") {
		t.Error("нет названия магазина")
	}
}

func TestShopHiddenDoesNotPunish(t *testing.T) {
	tpl := ShopHidden("Seoul Wear", "https://katalog.ru", "seoul", 3)

	if !strings.Contains(tpl.Text, "Фотографии целы") {
		t.Errorf("письмо обязано снимать страх потери фото:\n%s", tpl.Text)
	}
	if !strings.Contains(tpl.Subject, "сохранены") {
		t.Errorf("тема должна успокаивать, а не обвинять: %q", tpl.Subject)
	}
	// Слова-обвинения в этом письме недопустимы: продавец, не заплативший
	// из-за нехватки денег, скорее вернётся, если не чувствует себя брошенным.
	for _, bad := range []string{"заблокирован", "нарушен", "удалены", "долг"} {
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
	tpl := ChargeFailed("Shop", "https://katalog.ru", 7)
	if !strings.Contains(tpl.Text, "/app/billing") {
		t.Error("нет ссылки на смену способа оплаты")
	}
	if !strings.Contains(tpl.Text, "7 дней") {
		t.Error("не сказано, сколько ещё работает витрина")
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

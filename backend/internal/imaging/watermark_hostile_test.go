package imaging

import "testing"

// Текст знака продавец пишет руками, и libvips передаёт его в Pango.
// Ломающая разметка не должна валить обработку целиком: иначе один символ
// в настройках навсегда останавливает загрузку фотографий магазина.
func TestWatermarkHostileText(t *testing.T) {
	src := solidJPEG(t, 800, 600)
	texts := []string{
		"@shop",
		"<b>жирный</b>",
		"a < b",
		"&",
		"<span foreign='x'>",
		"незакрытый <b",
	}
	for _, txt := range texts {
		if _, err := ProcessWithWatermark(src, Watermark{Text: txt, Opacity: 0.5}); err != nil {
			t.Errorf("текст %q ломает обработку фото: %v", txt, err)
		}
	}
}

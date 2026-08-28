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

// Подпись накладывается на кадр, а не пристраивается под ним. Внутри govips
// маска текста встраивается в холст «текст + смещение», и при переполнении
// растёт сама картинка: квадрат 400×400 приезжал как 400×626 — с пустой
// полосой под фотографией и поехавшим соотношением сторон.
func TestWatermarkKeepsDimensions(t *testing.T) {
	sizes := [][2]int{{400, 400}, {1200, 900}, {900, 1600}}
	for _, s := range sizes {
		w, h := s[0], s[1]
		src := solidJPEG(t, w, h)
		res, err := ProcessWithWatermark(src, Watermark{Text: "@shop", Opacity: 0.5})
		if err != nil {
			t.Fatalf("%dx%d: %v", w, h, err)
		}
		if res.Width != w || res.Height != h {
			t.Errorf("%dx%d со знаком стало %dx%d", w, h, res.Width, res.Height)
		}
	}
}

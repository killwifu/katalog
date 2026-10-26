package imaging

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"

	"katalog/backend/internal/imagingmeta"
)

// solidJPEG — ровная тёмная заливка: любое светлое пятно на выходе
// означает наложенную подпись.
func solidJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: 10, G: 10, B: 10, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return buf.Bytes()
}

func TestWatermark(t *testing.T) {
	src := solidJPEG(t, 1200, 1200)

	plain, err := Process(src)
	if err != nil {
		t.Fatalf("process without watermark: %v", err)
	}
	marked, err := ProcessWithWatermark(src, Watermark{Text: "@shop", Opacity: 0.9})
	if err != nil {
		t.Fatalf("process with watermark: %v", err)
	}

	// Деривативы те же по составу.
	if len(plain.Derivatives) != len(marked.Derivatives) {
		t.Fatalf("деривативов %d и %d", len(plain.Derivatives), len(marked.Derivatives))
	}

	// На крупных размерах подпись обязана изменить картинку.
	changed := 0
	for size, data := range marked.Derivatives {
		if size >= 800 && !bytes.Equal(data, plain.Derivatives[size]) {
			changed++
		}
	}
	if changed == 0 {
		t.Error("водяной знак не изменил ни один крупный дериватив")
	}

	t.Run("пустой текст ничего не меняет", func(t *testing.T) {
		none, err := ProcessWithWatermark(src, Watermark{Text: "", Opacity: 0.9})
		if err != nil {
			t.Fatalf("process: %v", err)
		}
		for size, data := range none.Derivatives {
			if !bytes.Equal(data, plain.Derivatives[size]) {
				t.Errorf("дериватив %d изменился без текста знака", size)
			}
		}
	})

	t.Run("нулевая прозрачность ничего не меняет", func(t *testing.T) {
		none, err := ProcessWithWatermark(src, Watermark{Text: "@shop", Opacity: 0})
		if err != nil {
			t.Fatalf("process: %v", err)
		}
		for size, data := range none.Derivatives {
			if !bytes.Equal(data, plain.Derivatives[size]) {
				t.Errorf("дериватив %d изменился при opacity=0", size)
			}
		}
	})

	// Метаданные должны оставаться вычищенными и со знаком.
	t.Run("знак не ломает зачистку метаданных", func(t *testing.T) {
		for _, data := range marked.Derivatives {
			if bytes.Contains(data, []byte("Exif")) || bytes.Contains(data, []byte("GPS")) {
				t.Error("в дериватив просочились метаданные")
			}
		}
	})
}

// brightCentroid — центр светлых пикселей дериватива в долях сторон кадра.
// На ровной тёмной заливке светлое пятно — это и есть подпись.
func brightCentroid(t *testing.T, webp []byte) (cx, cy float64) {
	t.Helper()
	img, err := vips.NewImageFromBuffer(webp)
	if err != nil {
		t.Fatalf("decode derivative: %v", err)
	}
	defer img.Close()
	if err := img.ToColorSpace(vips.InterpretationSRGB); err != nil {
		t.Fatalf("colourspace: %v", err)
	}
	pix, err := img.ToBytes()
	if err != nil {
		t.Fatalf("pixels: %v", err)
	}
	w, h, bands := img.Width(), img.Height(), img.Bands()
	var sx, sy, n float64
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if pix[(y*w+x)*bands] > 90 {
				sx += float64(x)
				sy += float64(y)
				n++
			}
		}
	}
	// Подпись «в пару пикселей» формально стоит на месте, но продавцу
	// бесполезна — на стенде так и вышло, пока тест смотрел только на
	// положение. Пять букв кеглем в 1/24 ширины — это тысячи пикселей.
	if n < 1000 {
		t.Fatalf("подпись нечитаема: светлых пикселей %d", int(n))
	}
	return sx / n / float64(w), sy / n / float64(h)
}

// Положение знака продавец выбирает на сетке 3×3. Проверяем по пикселям:
// раньше подпись при любых настройках оказывалась слева внизу.
func TestWatermarkPosition(t *testing.T) {
	src := solidJPEG(t, 1200, 900)
	// Ожидаемая треть кадра по каждой оси: 0 — начало, 1 — середина, 2 — конец.
	third := map[byte]int{'t': 0, 'm': 1, 'b': 2, 'l': 0, 'c': 1, 'r': 2}
	positions := append([]string{""}, imagingmeta.WatermarkPositions...)
	for _, pos := range positions {
		t.Run("положение "+pos, func(t *testing.T) {
			res, err := ProcessWithWatermark(src, Watermark{Text: "@shop", Opacity: 1, Position: pos})
			if err != nil {
				t.Fatalf("process: %v", err)
			}
			if res.Width != 1200 || res.Height != 900 {
				t.Fatalf("кадр стал %dx%d", res.Width, res.Height)
			}
			want := pos
			if want == "" {
				want = "br"
			}
			cx, cy := brightCentroid(t, res.Derivatives[1600])
			if got := int(cx * 3); got != third[want[1]] {
				t.Errorf("по горизонтали подпись в трети %d (центр %.2f), ожидалась %d", got, cx, third[want[1]])
			}
			if got := int(cy * 3); got != third[want[0]] {
				t.Errorf("по вертикали подпись в трети %d (центр %.2f), ожидалась %d", got, cy, third[want[0]])
			}
		})
	}
}

// brightQuadrants — в каких четвертях кадра есть светлые пиксели (>90).
func brightQuadrants(t *testing.T, webp []byte) map[[2]int]int {
	t.Helper()
	img, err := vips.NewImageFromBuffer(webp)
	if err != nil {
		t.Fatalf("decode derivative: %v", err)
	}
	defer img.Close()
	pix, err := img.ToBytes()
	if err != nil {
		t.Fatalf("pixels: %v", err)
	}
	w, h, bands := img.Width(), img.Height(), img.Bands()
	q := map[[2]int]int{}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if pix[(y*w+x)*bands] > 90 {
				q[[2]int{x * 2 / w, y * 2 / h}]++
			}
		}
	}
	return q
}

// Несколько клеток и «по всему кадру» (правка 3 из списка 26.10).
func TestWatermarkSeveralPlaces(t *testing.T) {
	src := solidJPEG(t, 1200, 900)
	for _, tc := range []struct {
		pos  string
		want [][2]int // четверти, где обязана быть подпись
		none [][2]int // четверти, где её быть не должно
	}{
		{"tl,br", [][2]int{{0, 0}, {1, 1}}, [][2]int{{1, 0}, {0, 1}}},
		{"tile", [][2]int{{0, 0}, {1, 0}, {0, 1}, {1, 1}}, nil},
	} {
		t.Run(tc.pos, func(t *testing.T) {
			res, err := ProcessWithWatermark(src, Watermark{Text: "@shop", Opacity: 1, Position: tc.pos})
			if err != nil {
				t.Fatalf("process: %v", err)
			}
			if res.Width != 1200 || res.Height != 900 {
				t.Fatalf("кадр стал %dx%d", res.Width, res.Height)
			}
			q := brightQuadrants(t, res.Derivatives[1600])
			for _, c := range tc.want {
				if q[c] < 300 {
					t.Errorf("в четверти %v подписи нет (%d px)", c, q[c])
				}
			}
			for _, c := range tc.none {
				if q[c] > 0 {
					t.Errorf("в четверти %v лишняя подпись (%d px)", c, q[c])
				}
			}
		})
	}
}

// На белом фоне белая подпись не видна — под ней тёмная тень.
func TestWatermarkVisibleOnWhite(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 1200, 900))
	for i := range img.Pix {
		img.Pix[i] = 255
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("encode: %v", err)
	}
	res, err := ProcessWithWatermark(buf.Bytes(), Watermark{Text: "@shop", Opacity: 0.55})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	out, err := vips.NewImageFromBuffer(res.Derivatives[1600])
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	defer out.Close()
	pix, err := out.ToBytes()
	if err != nil {
		t.Fatalf("pixels: %v", err)
	}
	dark := 0
	for i := 0; i < len(pix); i += out.Bands() {
		if pix[i] < 200 {
			dark++
		}
	}
	if dark < 500 {
		t.Errorf("на белом фоне знака не видно: тёмных пикселей %d", dark)
	}
}

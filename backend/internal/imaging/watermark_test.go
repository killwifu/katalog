package imaging

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
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

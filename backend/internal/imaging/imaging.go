// Package imaging — обработка изображений через govips (libvips).
// ВАЖНО: пакет требует CGO+libvips, его импортирует только worker,
// api-бинарник должен оставаться без CGO.
package imaging

import (
	"bytes"
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"

	"katalog/backend/internal/imagingmeta"
)

// Лимиты до декодирования — защита от декомпрессионных бомб.
const (
	MaxSide     = 12000
	MaxPixels   = 60_000_000
	WebpQuality = 82
)

// DerivativeSizes — деривативы (longest side, px). Покупателю уходят только они.
var DerivativeSizes = imagingmeta.DerivativeSizes

// ValidationError — постоянная ошибка контента: ретраи бессмысленны,
// фото помечается failed.
type ValidationError struct {
	Reason string
}

func (e *ValidationError) Error() string { return "imaging: " + e.Reason }

// DetectFormat проверяет magic bytes. Разрешены только jpeg/png/webp/heic.
// SVG и всё остальное — запрещено (см. CLAUDE.md).
func DetectFormat(data []byte) (string, error) {
	switch {
	case len(data) >= 3 && bytes.Equal(data[:3], []byte{0xFF, 0xD8, 0xFF}):
		return "jpeg", nil
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}):
		return "png", nil
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "webp", nil
	case len(data) >= 12 && bytes.Equal(data[4:8], []byte("ftyp")):
		brand := string(data[8:12])
		switch brand {
		case "heic", "heix", "hevc", "hevx", "mif1", "msf1":
			return "heic", nil
		}
		return "", &ValidationError{Reason: fmt.Sprintf("unsupported container brand %q", brand)}
	default:
		return "", &ValidationError{Reason: "not a supported image (jpeg/png/webp/heic)"}
	}
}

type Result struct {
	Width       int
	Height      int
	PHash       int64
	Derivatives map[int][]byte // size px -> webp bytes
}

// Watermark — текстовая подпись поверх деривативов. Накладывается при
// загрузке, а не на лету: смена настроек не затрагивает уже загруженное
// (так и написано в интерфейсе кабинета).
//
// Только текст. Логотип-картинка — отдельная загрузка файла и хранение,
// заводить их ради одного тарифа рано.
type Watermark struct {
	Text    string
	Opacity float64 // 0..1; 0 или пусто — знака нет
}

// Process валидирует изображение и строит деривативы.
// Порядок инварианта: magic bytes -> лимит разрешения ДО декодирования ->
// EXIF-ориентация применяется, метаданные полностью вычищаются (геометки!) ->
// WebP-деривативы -> pHash.
func Process(data []byte) (*Result, error) {
	return ProcessWithWatermark(data, Watermark{})
}

func ProcessWithWatermark(data []byte, wm Watermark) (*Result, error) {
	if _, err := DetectFormat(data); err != nil {
		return nil, err
	}

	// NewImageFromBuffer у vips ленивый: до обращения к пикселям читается
	// только заголовок — размеры проверяются без полного декодирования.
	header, err := vips.NewImageFromBuffer(data)
	if err != nil {
		return nil, &ValidationError{Reason: fmt.Sprintf("cannot read image header: %v", err)}
	}
	w, h := header.Width(), header.Height()
	header.Close()
	if w <= 0 || h <= 0 {
		return nil, &ValidationError{Reason: "empty image"}
	}
	if w > MaxSide || h > MaxSide || w*h > MaxPixels {
		return nil, &ValidationError{Reason: fmt.Sprintf("image %dx%d exceeds limits (%d px side, %d px total)", w, h, MaxSide, MaxPixels)}
	}

	result := &Result{Derivatives: make(map[int][]byte, len(DerivativeSizes))}

	// vips thumbnail сам применяет EXIF-ориентацию (autorotate).
	for _, size := range DerivativeSizes {
		thumb, err := vips.NewThumbnailWithSizeFromBuffer(data, size, size, vips.InterestingNone, vips.SizeDown)
		if err != nil {
			return nil, &ValidationError{Reason: fmt.Sprintf("decode failed: %v", err)}
		}
		// Знак кладём на уже уменьшённый дериватив: на превью 300px
		// подпись от полноразмерного кадра была бы нечитаемой.
		if err := applyWatermark(thumb, wm); err != nil {
			thumb.Close()
			return nil, fmt.Errorf("watermark %d: %w", size, err)
		}
		params := vips.NewWebpExportParams()
		params.Quality = WebpQuality
		params.StripMetadata = true // полная зачистка EXIF/GPS
		out, _, err := thumb.ExportWebp(params)
		if size == DerivativeSizes[len(DerivativeSizes)-1] {
			// Размеры после autorotate берём с самого большого дериватива.
			result.Width, result.Height = thumb.Width(), thumb.Height()
		}
		thumb.Close()
		if err != nil {
			return nil, fmt.Errorf("export webp %d: %w", size, err)
		}
		result.Derivatives[size] = out
	}

	phash, err := averageHash(data)
	if err != nil {
		return nil, fmt.Errorf("phash: %w", err)
	}
	result.PHash = phash

	return result, nil
}

// averageHash — 64-битный перцептивный хеш (aHash): 8x8 grayscale,
// бит = яркость выше средней.
func averageHash(data []byte) (int64, error) {
	img, err := vips.NewThumbnailWithSizeFromBuffer(data, 8, 8, vips.InterestingNone, vips.SizeForce)
	if err != nil {
		return 0, fmt.Errorf("thumbnail 8x8: %w", err)
	}
	defer img.Close()
	if err := img.ToColorSpace(vips.InterpretationBW); err != nil {
		return 0, fmt.Errorf("to grayscale: %w", err)
	}

	// ToBytes материализует пайплайн одним последовательным проходом:
	// случайный доступ (GetPoint) к sequential-загрузке JPEG запрещён
	// в libvips ("out of order read").
	bands := img.Bands()
	raw, err := img.ToBytes()
	if err != nil {
		return 0, fmt.Errorf("read pixels: %w", err)
	}
	if bands <= 0 || len(raw) < 64*bands {
		return 0, fmt.Errorf("unexpected raw pixel buffer: %d bytes, %d bands", len(raw), bands)
	}

	var px [64]float64
	var sum float64
	for i := range px {
		v := float64(raw[i*bands])
		px[i] = v
		sum += v
	}
	avg := sum / 64
	var hash uint64
	for i, v := range px {
		if v > avg {
			hash |= 1 << uint(i)
		}
	}
	return int64(hash), nil
}

// applyWatermark рисует подпись в правом нижнем углу. Размер шрифта —
// доля ширины кадра, иначе на thumb знак закроет фото, а на large
// потеряется.
func applyWatermark(img *vips.ImageRef, wm Watermark) error {
	if wm.Text == "" || wm.Opacity <= 0 {
		return nil
	}
	fontSize := img.Width() / 24
	if fontSize < 9 {
		// На совсем мелких превью читаемой подписи не выйдет — не портим кадр.
		return nil
	}
	opacity := wm.Opacity
	if opacity > 1 {
		opacity = 1
	}
	return img.Label(&vips.LabelParams{
		Text:      wm.Text,
		Font:      fmt.Sprintf("sans %d", fontSize),
		Width:     vips.Scalar{Value: 0.92, Relative: true},
		Height:    vips.Scalar{Value: 0.92, Relative: true},
		OffsetX:   vips.Scalar{Value: 0.04, Relative: true},
		OffsetY:   vips.Scalar{Value: 0.88, Relative: true},
		Opacity:   float32(opacity),
		Color:     vips.Color{R: 255, G: 255, B: 255},
		Alignment: vips.AlignLow,
	})
}

// Package imaging — обработка изображений через govips (libvips).
// ВАЖНО: пакет требует CGO+libvips, его импортирует только worker,
// api-бинарник должен оставаться без CGO.
package imaging

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"html"
	"image"

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
var DerivativeSizes = imagingmeta.DerivativeSizes()

// Код причины отказа. Хранится у фотографии и переводится в кабинете:
// продавцу нужно понять, что чинить, а не читать английскую диагностику.
type FailCode string

const (
	FailUnsupportedFormat FailCode = "unsupported_format"
	FailCorrupt           FailCode = "corrupt"
	FailTooLarge          FailCode = "too_large"
	FailEmpty             FailCode = "empty"
)

// ValidationError — постоянная ошибка контента: ретраи бессмысленны,
// фото помечается failed. Reason — техническая диагностика для логов,
// Code — то, по чему кабинет выбирает объяснение продавцу.
type ValidationError struct {
	Code   FailCode
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
		return "", &ValidationError{Code: FailUnsupportedFormat, Reason: fmt.Sprintf("unsupported container brand %q", brand)}
	default:
		return "", &ValidationError{Code: FailUnsupportedFormat, Reason: "not a supported image (jpeg/png/webp/heic)"}
	}
}

// truncatedJPEG: после последнего маркера начала скана (FFDA) обязан быть
// маркер конца изображения (FFD9). Внутри сжатых данных байт FF всегда
// экранирован (FF00) или означает рестарт (FFD0–FFD7), поэтому FFD9 там
// не встречается — у оборванного файла его после скана нет. Хвосты после
// конца кадра (MPF, служебные блоки камер) этому не мешают: у них либо
// свой скан со своим FFD9, либо после основного FFD9 нет нового FFDA.
func truncatedJPEG(data []byte) bool {
	sos := bytes.LastIndex(data, []byte{0xFF, 0xDA})
	if sos < 0 {
		return true
	}
	return !bytes.Contains(data[sos+2:], []byte{0xFF, 0xD9})
}

type Result struct {
	Width       int
	Height      int
	PHash       int64
	Derivatives map[int][]byte // size px -> webp bytes
}

// Watermark — текстовая подпись поверх деривативов. Накладывается при
// обработке, а не на лету: смена знака альбома перерисовывает его фото
// отдельной задачей (worker.HandleAlbumRewatermark).
//
// Только текст. Логотип-картинка — отдельная загрузка файла и хранение,
// заводить их ради одного тарифа рано.
type Watermark struct {
	Text    string
	Opacity float64 // 0..1; 0 или пусто — знака нет
	// Position — точки сетки 3×3 через запятую или «tile» — по всему кадру
	// (imagingmeta.WatermarkCells). Пусто — правый нижний угол.
	Position string
}

// Process валидирует изображение и строит деривативы.
// Порядок инварианта: magic bytes -> лимит разрешения ДО декодирования ->
// EXIF-ориентация применяется, метаданные полностью вычищаются (геометки!) ->
// WebP-деривативы -> pHash.
func Process(data []byte) (*Result, error) {
	return ProcessWithWatermark(data, Watermark{})
}

func ProcessWithWatermark(data []byte, wm Watermark) (*Result, error) {
	format, err := DetectFormat(data)
	if err != nil {
		return nil, err
	}
	// libvips декодирует обрезанный JPEG без ошибки, заливая недостающее
	// серым, — покупатель увидел бы полкадра. Ловим обрыв сами.
	if format == "jpeg" && truncatedJPEG(data) {
		return nil, &ValidationError{Code: FailCorrupt, Reason: "truncated jpeg: no end-of-image marker after scan data"}
	}

	// NewImageFromBuffer у vips ленивый: до обращения к пикселям читается
	// только заголовок — размеры проверяются без полного декодирования.
	header, err := vips.NewImageFromBuffer(data)
	if err != nil {
		return nil, &ValidationError{Code: FailCorrupt, Reason: fmt.Sprintf("cannot read image header: %v", err)}
	}
	w, h := header.Width(), header.Height()
	header.Close()
	if w <= 0 || h <= 0 {
		return nil, &ValidationError{Code: FailEmpty, Reason: "empty image"}
	}
	if w > MaxSide || h > MaxSide || w*h > MaxPixels {
		return nil, &ValidationError{Code: FailTooLarge, Reason: fmt.Sprintf("image %dx%d exceeds limits (%d px side, %d px total)", w, h, MaxSide, MaxPixels)}
	}

	result := &Result{Derivatives: make(map[int][]byte, len(DerivativeSizes))}

	// vips thumbnail сам применяет EXIF-ориентацию (autorotate).
	for _, size := range DerivativeSizes {
		thumb, err := vips.NewThumbnailWithSizeFromBuffer(data, size, size, vips.InterestingNone, vips.SizeDown)
		if err != nil {
			return nil, &ValidationError{Code: FailCorrupt, Reason: fmt.Sprintf("decode failed: %v", err)}
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
		// Флагу strip верить нельзя: govips передаёт устаревший параметр, и
		// libvips 8.16 (та, что в образе) пишет в WebP EXIF-чанк всегда —
		// деривативы на витрине уходили с GPS-координатами продавца, хотя
		// локальный тест на libvips 8.18 был зелёным. Вырезаем EXIF/XMP из
		// контейнера сами, а дериватив, где они всё же остались, не публикуем.
		if err == nil {
			out = stripWebPMetadata(out)
			if webpHasMetadata(out) {
				err = errMetadataSurvived
			}
		}
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

// applyWatermark рисует подпись в выбранной точке кадра. Размер шрифта —
// доля ширины кадра, иначе на small знак закроет фото, а на large
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
	// libvips отдаёт текст в Pango как разметку: «Обувь & сумки» или
	// «цена < 5000» — это невалидный markup, и знак не просто не
	// рисуется, а роняет обработку. Один амперсанд в настройках
	// навсегда останавливал загрузку фотографий магазина.
	//
	// Цвет и прозрачность задаются той же разметкой: подпись рисуется
	// отдельной RGBA-картинкой и накладывается на кадр. Так известен её
	// размер, а значит, и точка, куда её ставить. Label из govips размера
	// не отдаёт и всегда ставил подпись слева внизу, хотя комментарий
	// обещал правый угол; без autofit по высоте он к тому же рисует
	// текст в пару пикселей.
	text := html.EscapeString(wm.Text)
	render := func(markup string) (*vips.ImageRef, error) {
		return vips.Text(&vips.TextParams{
			Text:      markup,
			Font:      fmt.Sprintf("sans %d", fontSize),
			Width:     int(float64(img.Width()) * watermarkBoxW),
			Alignment: vips.AlignLow,
			DPI:       72,
			RGBA:      true,
		})
	}
	overlay, err := render(fmt.Sprintf(`<span foreground="white" alpha="%d%%">%s</span>`, int(opacity*100+0.5), text))
	if err != nil {
		return fmt.Errorf("render text: %w", err)
	}
	defer overlay.Close()
	// Тёмная тень под белым текстом: на белом фоне одна белая подпись
	// не видна совсем.
	shadow, err := render(fmt.Sprintf(`<span foreground="black" alpha="%d%%">%s</span>`, int(opacity*60+0.5), text))
	if err != nil {
		return fmt.Errorf("render shadow: %w", err)
	}
	defer shadow.Close()
	if overlay.Width() > img.Width() || overlay.Height() > img.Height() {
		// Длинная подпись на узкой панораме переносится на несколько
		// строк и в кадр не помещается — лучше без знака, чем обрезок.
		return nil
	}

	var layers []*vips.ImageComposite
	shift := max(1, fontSize/14)
	for _, p := range watermarkPoints(img.Width(), img.Height(), overlay.Width(), overlay.Height(), wm.Position) {
		layers = append(layers,
			&vips.ImageComposite{Image: shadow, BlendMode: vips.BlendModeOver, X: p.X + shift, Y: p.Y + shift},
			&vips.ImageComposite{Image: overlay, BlendMode: vips.BlendModeOver, X: p.X, Y: p.Y},
		)
	}
	hadAlpha := img.HasAlpha()
	if err := img.CompositeMulti(layers); err != nil {
		return fmt.Errorf("composite: %w", err)
	}
	if !hadAlpha && img.HasAlpha() {
		// Наложение добавляет кадру альфа-канал. Непрозрачному снимку он
		// не нужен: WebP с альфой тяжелее, а это 95% трафика.
		if err := img.Flatten(&vips.Color{}); err != nil {
			return fmt.Errorf("flatten: %w", err)
		}
	}
	return nil
}

// watermarkPoints — левые верхние углы всех копий подписи: по точке на
// каждую выбранную клетку сетки или шахматная раскладка по всему кадру.
func watermarkPoints(imgW, imgH, textW, textH int, pos string) []image.Point {
	cells, ok := imagingmeta.WatermarkCells(pos)
	if !ok {
		cells = []string{"br"}
	}
	if cells[0] == imagingmeta.WatermarkTile {
		// Шаг — подпись плюс зазор; каждая вторая строка сдвинута на
		// полшага, иначе копии встают столбиками. Края обрезаются кадром.
		// Короткая подпись дала бы сотни копий (по два слоя на каждую) —
		// шаг не меньше 1/6 ширины и 1/10 высоты кадра.
		stepX, stepY := max(textW+textW/2, imgW/6), max(textH*3, imgH/10)
		var pts []image.Point
		for row, y := 0, textH/2; y < imgH; row, y = row+1, y+stepY {
			for x := -(row % 2) * stepX / 2; x < imgW; x += stepX {
				pts = append(pts, image.Point{X: x, Y: y})
			}
		}
		return pts
	}
	pts := make([]image.Point, len(cells))
	for i, c := range cells {
		pts[i].X, pts[i].Y = watermarkOffset(imgW, imgH, textW, textH, c)
	}
	return pts
}

// watermarkOffset — левый верхний угол подписи для выбранной точки кадра.
//
// Подпись обязана уместиться в кадр целиком: с прежним способом отрисовки
// вылезший за край текст растягивал саму картинку — квадрат 400×400
// превращался в 400×626, покупатель видел пустую полосу под фотографией.
// Поэтому смещение зажимается так, чтобы offset + размер текста не
// превышал сторону.
func watermarkOffset(imgW, imgH, textW, textH int, pos string) (x, y int) {
	if !imagingmeta.ValidWatermarkPosition(pos) || pos == "" {
		pos = "br"
	}
	marginX := int(float64(imgW) * watermarkMargin)
	marginY := int(float64(imgH) * watermarkMargin)
	switch pos[1] {
	case 'l':
		x = marginX
	case 'c':
		x = (imgW - textW) / 2
	default:
		x = imgW - marginX - textW
	}
	switch pos[0] {
	case 't':
		y = marginY
	case 'm':
		y = (imgH - textH) / 2
	default:
		y = imgH - marginY - textH
	}
	return clamp(x, imgW-textW), clamp(y, imgH-textH)
}

func clamp(v, hi int) int {
	if v > hi {
		v = hi
	}
	if v < 0 {
		v = 0
	}
	return v
}

// Коробка подписи и поля до края, в долях стороны кадра.
const (
	watermarkBoxW   = 0.92
	watermarkMargin = 0.04
)

// errMetadataSurvived — в готовом WebP остались EXIF или XMP.
var errMetadataSurvived = errors.New("metadata survived strip")

// webpHasMetadata ищет в RIFF-контейнере WebP чанки EXIF и XMP.
func webpHasMetadata(b []byte) bool {
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return false
	}
	for i := 12; i+8 <= len(b); {
		fourcc := string(b[i : i+4])
		size := int(binary.LittleEndian.Uint32(b[i+4 : i+8]))
		if fourcc == "EXIF" || fourcc == "XMP " {
			return true
		}
		if size < 0 || size > len(b) {
			return false
		}
		i += 8 + size + size%2
	}
	return false
}

// StripWebPMetadata — stripWebPMetadata для разовой зачистки старых деривативов.
func StripWebPMetadata(b []byte) []byte { return stripWebPMetadata(b) }

// stripWebPMetadata вырезает из RIFF-контейнера WebP чанки EXIF и XMP и
// снимает их флаги в VP8X (спецификация WebP Container: E=0x08, X=0x04).
// Пиксели не трогает. Неизвестный формат возвращает как есть.
func stripWebPMetadata(b []byte) []byte {
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return b
	}
	out := make([]byte, 0, len(b))
	out = append(out, b[:12]...)
	for i := 12; i+8 <= len(b); {
		fourcc := string(b[i : i+4])
		size := int(binary.LittleEndian.Uint32(b[i+4 : i+8]))
		end := i + 8 + size + size%2
		if size < 0 || end > len(b) {
			return b // повреждённый контейнер — не правим
		}
		switch fourcc {
		case "EXIF", "XMP ":
			// пропускаем
		case "VP8X":
			chunk := append([]byte(nil), b[i:end]...)
			if size >= 1 {
				chunk[8] &^= 0x08 | 0x04
			}
			out = append(out, chunk...)
		default:
			out = append(out, b[i:end]...)
		}
		i = end
	}
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(out)-8))
	return out
}

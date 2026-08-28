package imaging

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"
)

// exifMarker — узнаваемая строка в ImageDescription. Ищем именно её:
// признак «Exif» может встретиться в сжатых данных случайно, а такую
// строку в кадре из одного цвета взяться неоткуда.
const exifMarker = "SECRET-GEO-MARKER"

// jpegWithEXIF вклеивает APP1 с EXIF сразу после SOI: ImageDescription
// с меткой и Orientation=6 (поворот на 90°). Ориентация нужна, чтобы
// убедиться, что блок настоящий и libvips его разобрал, — иначе тест
// «метаданные не просочились» проходил бы и на картинке без EXIF вовсе.
func jpegWithEXIF(t *testing.T, w, h int) []byte {
	t.Helper()
	src := solidJPEG(t, w, h)
	if !bytes.HasPrefix(src, []byte{0xFF, 0xD8}) {
		t.Fatalf("не JPEG: % x", src[:4])
	}

	desc := append([]byte(exifMarker), 0)
	const ifdEnd = 8 + 2 + 2*12 + 4 // заголовок + счётчик + две записи + ссылка

	var tiff bytes.Buffer
	tiff.WriteString("II")
	le(&tiff, uint16(42))
	le(&tiff, uint32(8))
	le(&tiff, uint16(2))

	// 0x010E ImageDescription, ASCII, значение по смещению.
	le(&tiff, uint16(0x010E))
	le(&tiff, uint16(2))
	le(&tiff, uint32(len(desc)))
	le(&tiff, uint32(ifdEnd))

	// 0x0112 Orientation, SHORT, значение в самой записи.
	le(&tiff, uint16(0x0112))
	le(&tiff, uint16(3))
	le(&tiff, uint32(1))
	le(&tiff, uint16(6))
	le(&tiff, uint16(0))

	le(&tiff, uint32(0)) // следующего IFD нет
	tiff.Write(desc)

	payload := append([]byte("Exif\x00\x00"), tiff.Bytes()...)
	var out bytes.Buffer
	out.Write(src[:2])
	out.Write([]byte{0xFF, 0xE1})
	if err := binary.Write(&out, binary.BigEndian, uint16(len(payload)+2)); err != nil {
		t.Fatalf("write app1 length: %v", err)
	}
	out.Write(payload)
	out.Write(src[2:])
	return out.Bytes()
}

// le пишет значение в буфер: запись в bytes.Buffer ошибку вернуть не может.
func le(buf *bytes.Buffer, v any) {
	_ = binary.Write(buf, binary.LittleEndian, v)
}

// TestEXIFStrippedFromDerivatives — приватный инвариант из CLAUDE.md:
// ориентацию применяем, метаданные вычищаем полностью. В EXIF лежат
// геометки, и уехать вместе с фотографией к покупателю они не должны.
func TestEXIFStrippedFromDerivatives(t *testing.T) {
	src := jpegWithEXIF(t, 1200, 800)

	// Фикстура настоящая: libvips видит ориентацию из вклеенного блока.
	img, err := vips.NewImageFromBuffer(src)
	if err != nil {
		t.Fatalf("исходник не читается: %v", err)
	}
	orientation := img.Metadata().Orientation
	img.Close()
	if orientation != 6 {
		t.Fatalf("EXIF не разобран: ориентация %d, ожидалась 6", orientation)
	}
	if !bytes.Contains(src, []byte(exifMarker)) {
		t.Fatal("метки нет в исходнике — тест ничего не проверяет")
	}

	res, err := Process(src)
	if err != nil {
		t.Fatalf("process: %v", err)
	}

	for size, data := range res.Derivatives {
		if bytes.Contains(data, []byte(exifMarker)) {
			t.Errorf("дериватив %d унёс метаданные исходника", size)
		}
	}

	// Ориентация 6 — поворот на 90°, стороны должны поменяться местами.
	if res.Width != 800 || res.Height != 1200 {
		t.Errorf("EXIF-ориентация не применена: %dx%d, ожидалось 800x1200", res.Width, res.Height)
	}
}

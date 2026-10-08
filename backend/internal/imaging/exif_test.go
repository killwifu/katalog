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

// TestWebPMetadataGuard — страховка поверх зачистки: RIFF-разбор находит
// чанки EXIF/XMP в WebP (такой дериватив не публикуется).
func TestWebPMetadataGuard(t *testing.T) {
	chunk := func(fourcc string, data []byte) []byte {
		b := append([]byte(fourcc), byte(len(data)), byte(len(data)>>8), byte(len(data)>>16), byte(len(data)>>24))
		b = append(b, data...)
		if len(data)%2 == 1 {
			b = append(b, 0)
		}
		return b
	}
	webp := func(chunks ...[]byte) []byte {
		body := []byte("WEBP")
		for _, c := range chunks {
			body = append(body, c...)
		}
		n := len(body)
		return append([]byte{'R', 'I', 'F', 'F', byte(n), byte(n >> 8), byte(n >> 16), byte(n >> 24)}, body...)
	}
	clean := webp(chunk("VP8X", make([]byte, 10)), chunk("VP8 ", []byte{1, 2, 3}))
	if webpHasMetadata(clean) {
		t.Fatal("clean webp reported as having metadata")
	}
	for _, fc := range []string{"EXIF", "XMP "} {
		if !webpHasMetadata(webp(chunk("VP8X", make([]byte, 10)), chunk("VP8 ", []byte{1, 2, 3}), chunk(fc, []byte("Exif\x00\x00GPS")))) {
			t.Fatalf("%s chunk not detected", fc)
		}
	}
	// Настоящий дериватив из JPEG с EXIF чист.
	res, err := Process(jpegWithEXIF(t, 120, 80))
	if err != nil {
		t.Fatal(err)
	}
	for size, data := range res.Derivatives {
		if webpHasMetadata(data) {
			t.Fatalf("derivative %d carries EXIF/XMP", size)
		}
	}
}

// TestStripWebPMetadata: EXIF/XMP вырезаются, флаги VP8X снимаются, размер RIFF
// пересчитан, остальные чанки целы.
func TestStripWebPMetadata(t *testing.T) {
	vp8x := []byte{'V', 'P', '8', 'X', 10, 0, 0, 0, 0x08 | 0x04 | 0x10, 0, 0, 0, 1, 0, 0, 1, 0, 0}
	vp8 := []byte{'V', 'P', '8', ' ', 3, 0, 0, 0, 9, 9, 9, 0}
	exif := append([]byte{'E', 'X', 'I', 'F', 9, 0, 0, 0}, []byte("Exif\x00\x00GPS")...)
	exif = append(exif, 0)
	xmp := append([]byte{'X', 'M', 'P', ' ', 4, 0, 0, 0}, []byte("<x/>")...)
	body := append(append(append(append([]byte("WEBP"), vp8x...), vp8...), exif...), xmp...)
	n := len(body)
	src := append([]byte{'R', 'I', 'F', 'F', byte(n), byte(n >> 8), byte(n >> 16), byte(n >> 24)}, body...)

	got := stripWebPMetadata(src)
	if webpHasMetadata(got) {
		t.Fatal("metadata chunks survived")
	}
	if got[12+8]&(0x08|0x04) != 0 || got[12+8]&0x10 == 0 {
		t.Fatalf("VP8X flags = %#x, want EXIF/XMP cleared and alpha kept", got[12+8])
	}
	if size := int(got[4]) | int(got[5])<<8 | int(got[6])<<16 | int(got[7])<<24; size != len(got)-8 {
		t.Fatalf("RIFF size = %d, want %d", size, len(got)-8)
	}
	if !bytes.Contains(got, []byte{'V', 'P', '8', ' ', 3, 0, 0, 0, 9, 9, 9}) {
		t.Fatal("image chunk lost")
	}
}

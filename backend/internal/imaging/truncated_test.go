package imaging

import (
	"errors"
	"testing"
)

// Обрезанный JPEG (файл недокачан или побит) libvips декодирует без ошибки,
// заливая хвост серым. Такой кадр должен отклоняться, а целый файл —
// в том числе с мусором после конца кадра, как у некоторых камер, —
// проходить.
func TestTruncatedJPEG(t *testing.T) {
	src := solidJPEG(t, 400, 300)
	if _, err := Process(src); err != nil {
		t.Fatalf("целый JPEG отклонён: %v", err)
	}

	cut := src[:len(src)*2/3]
	_, err := Process(cut)
	var ve *ValidationError
	if !errors.As(err, &ve) || ve.Code != FailCorrupt {
		t.Fatalf("обрезанный JPEG: ошибка %v, ожидалась %s", err, FailCorrupt)
	}

	trailer := append(append([]byte{}, src...), []byte("SEFHtrailer-from-camera\x00\x01\x02")...)
	if _, err := Process(trailer); err != nil {
		t.Errorf("JPEG с хвостом после конца кадра отклонён: %v", err)
	}
}

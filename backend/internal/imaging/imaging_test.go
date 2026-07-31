package imaging

import (
	"errors"
	"testing"
)

func TestDetectFormat(t *testing.T) {
	tests := []struct {
		name       string
		data       []byte
		wantFormat string
		wantErr    bool
	}{
		{name: "jpeg", data: []byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0}, wantFormat: "jpeg"},
		{name: "png", data: []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0}, wantFormat: "png"},
		{name: "webp", data: []byte("RIFF\x00\x00\x00\x00WEBPVP8 "), wantFormat: "webp"},
		{name: "heic", data: []byte("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00"), wantFormat: "heic"},
		{name: "svg is forbidden", data: []byte(`<svg xmlns="http://www.w3.org/2000/svg">`), wantErr: true},
		{name: "xml svg", data: []byte(`<?xml version="1.0"?><svg>`), wantErr: true},
		{name: "gif not allowed", data: []byte("GIF89a\x00\x00"), wantErr: true},
		{name: "plain text", data: []byte("hello world, not an image"), wantErr: true},
		{name: "empty", data: nil, wantErr: true},
		{name: "mp4 container", data: []byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00"), wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			format, err := DetectFormat(tt.data)
			if tt.wantErr {
				var vErr *ValidationError
				if err == nil || !errors.As(err, &vErr) {
					t.Fatalf("DetectFormat: want ValidationError, got format=%q err=%v", format, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("DetectFormat: unexpected error %v", err)
			}
			if format != tt.wantFormat {
				t.Errorf("DetectFormat = %q, want %q", format, tt.wantFormat)
			}
		})
	}
}

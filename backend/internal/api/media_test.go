package api

import (
	"testing"

	"github.com/google/uuid"

	"katalog/backend/internal/config"
)

// Адреса деривативов должны уметь уезжать на отдельный CDN-домен:
// контент не отдаётся с домена приложения (CLAUDE.md).
func TestMediaURLs(t *testing.T) {
	shop := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	photo := uuid.MustParse("22222222-2222-2222-2222-222222222222")

	tests := []struct {
		name      string
		base      string
		wantThumb string
		wantLarge string
	}{
		{
			name:      "относительный путь по умолчанию",
			base:      "/media",
			wantThumb: "/media/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/small.webp",
			wantLarge: "/media/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/large.webp",
		},
		{
			// API собирают и напрямую, минуя config.Load: пустой префикс
			// не должен превращаться в битые адреса.
			name:      "пустой префикс — как относительный",
			base:      "",
			wantThumb: "/media/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/small.webp",
			wantLarge: "/media/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/large.webp",
		},
		{
			name:      "отдельный CDN-домен",
			base:      "https://cdn.example.com/drv",
			wantThumb: "https://cdn.example.com/drv/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/small.webp",
			wantLarge: "https://cdn.example.com/drv/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/large.webp",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := &API{Cfg: config.Config{MediaBaseURL: tt.base}}
			got := a.mediaURLs(shop, photo)
			if got["small"] != tt.wantThumb {
				t.Errorf("small = %q, want %q", got["small"], tt.wantThumb)
			}
			if got["large"] != tt.wantLarge {
				t.Errorf("large = %q, want %q", got["large"], tt.wantLarge)
			}
		})
	}
}

// Хвостовой слэш в MEDIA_BASE_URL не должен давать двойной // в адресах.
func TestMediaBaseURLTrimsTrailingSlash(t *testing.T) {
	t.Setenv("MEDIA_BASE_URL", "https://cdn.example.com/drv/")
	if got := config.Load().MediaBaseURL; got != "https://cdn.example.com/drv" {
		t.Errorf("MediaBaseURL = %q, want %q", got, "https://cdn.example.com/drv")
	}
}

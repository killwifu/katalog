package storage

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUploadDerivativeCacheControl(t *testing.T) {
	for _, key := range []string{"drv/shop/photo/small.webp", "orig/shop/photo"} {
		t.Run(key, func(t *testing.T) {
			var cache string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				cache = r.Header.Get("Cache-Control")
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("ETag", `"test"`)
				w.WriteHeader(http.StatusOK)
			}))
			defer server.Close()
			store, err := New(server.URL, server.URL, "test", "test-secret", "test", "us-east-1")
			if err != nil {
				t.Fatal(err)
			}
			if err := store.Upload(t.Context(), key, []byte("image"), "image/webp"); err != nil {
				t.Fatal(err)
			}
			want := ""
			if key == "drv/shop/photo/small.webp" {
				want = "public, max-age=31536000, immutable"
			}
			if cache != want {
				t.Fatalf("Cache-Control = %q, want %q", cache, want)
			}
		})
	}
}

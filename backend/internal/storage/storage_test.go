package storage

import (
	"bytes"
	"fmt"
	"github.com/minio/minio-go/v7"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDownloadBoundsOriginal(t *testing.T) {
	for _, size := range []int{10 << 20, (10 << 20) + 1} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			blob := bytes.Repeat([]byte{'x'}, size)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// No Content-Length: the read itself must enforce the bound.
				w.Header().Set("Content-Type", "application/octet-stream")
				w.Header().Set("Last-Modified", "Mon, 02 Jan 2006 15:04:05 GMT")
				w.Header().Set("ETag", `"test"`)
				w.WriteHeader(http.StatusOK)
				w.(http.Flusher).Flush()
				_, _ = w.Write(blob)
			}))
			defer server.Close()
			store, err := New(server.URL, server.URL, "test", "test-secret", "test", "us-east-1")
			if err != nil {
				t.Fatal(err)
			}
			got, err := store.Download(t.Context(), "orig/test/photo")
			if size > 10<<20 {
				if err == nil || len(got) != 0 {
					t.Fatalf("oversized download returned %d bytes, err=%v", len(got), err)
				}
			} else if err != nil || !bytes.Equal(got, blob) {
				t.Fatalf("limit-sized download: %d bytes, err=%v", len(got), err)
			}
		})
	}
}

// A chunked response must stop being read, not merely be rejected after ReadAll.
func TestDownloadStopsReadingAtLimit(t *testing.T) {
	body := &countedBody{ReadCloser: io.NopCloser(bytes.NewReader(make([]byte, 24<<20))), closed: make(chan struct{})}
	client, err := minio.New("storage.test", &minio.Options{Region: "us-east-1", Transport: downloadTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Last-Modified": []string{"Mon, 02 Jan 2006 15:04:05 GMT"}, "Etag": []string{`"test"`}}, Body: body, ContentLength: -1, Request: r}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	store := &Client{ops: client, bucket: "test"}
	got, err := store.Download(t.Context(), "orig/test/photo")
	if err == nil || len(got) != 0 {
		t.Fatalf("oversized download: %d bytes, err=%v", len(got), err)
	}
	select {
	case <-body.closed:
	case <-time.After(time.Second):
		t.Fatal("response body was not closed")
	}
	if body.bytesRead > (10<<20)+1 {
		t.Fatalf("read %d bytes, want at most 10485761", body.bytesRead)
	}
}

type downloadTransport func(*http.Request) (*http.Response, error)

func (f downloadTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type countedBody struct {
	io.ReadCloser
	bytesRead int
	closed    chan struct{}
}

func (b *countedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.bytesRead += n
	return n, err
}
func (b *countedBody) Close() error { close(b.closed); return b.ReadCloser.Close() }

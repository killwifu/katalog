package integration

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// Use the actual upload route and Host rewrite from the repository Caddyfile.
func uploadProxy(t *testing.T, signed *url.URL) string {
	t.Helper()
	config, err := os.ReadFile("../../../deploy/Caddyfile")
	if err != nil {
		t.Fatal(err)
	}
	config = bytes.ReplaceAll(config, []byte("minio:9000"), []byte("host.docker.internal:"+signed.Port()))
	proxy, err := testcontainers.GenericContainer(t.Context(), testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image: "caddy:2-alpine", ExposedPorts: []string{"80/tcp"},
			Env:   map[string]string{"S3_BUCKET": testBucket, "S3_SIGNING_HOST": signed.Host},
			Files: []testcontainers.ContainerFile{{Reader: bytes.NewReader(config), ContainerFilePath: "/etc/caddy/Caddyfile", FileMode: 0644}},
			HostConfigModifier: func(c *container.HostConfig) {
				c.ExtraHosts = append(c.ExtraHosts, "host.docker.internal:host-gateway")
			},
			WaitingFor: wait.ForListeningPort("80/tcp"),
		}, Started: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := proxy.Terminate(context.Background()); err != nil {
			t.Error(err)
		}
	})
	host, err := proxy.Host(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	port, err := proxy.MappedPort(t.Context(), "80/tcp")
	if err != nil {
		t.Fatal(err)
	}
	return net.JoinHostPort(host, port.Port())
}

func TestPresignedOriginalSizeThroughCaddy(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)
	original := makeJPEG(t, 320, 240)
	var pre presignJSON
	c.mustJSON("POST", "/api/v1/uploads/presign", map[string]any{"shop_id": shop.ID, "album_id": album.ID, "size": len(original)}, http.StatusOK, &pre)
	signed, err := url.Parse(pre.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxyHost := uploadProxy(t, signed)
	put := func(blob []byte, chunked bool) int {
		t.Helper()
		target := *signed
		target.Host = proxyHost
		var reader io.Reader = bytes.NewReader(blob)
		if chunked {
			reader = io.NopCloser(reader)
		}
		req, err := http.NewRequest(http.MethodPut, target.String(), reader)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}
	if status := put(original, false); status != http.StatusOK {
		t.Fatalf("valid PUT through Caddy: %d", status)
	}
	c.mustJSON("POST", "/api/v1/photos/confirm", map[string]any{"shop_id": shop.ID, "photo_ids": []string{pre.PhotoID}}, http.StatusOK, nil)
	waitPhotoStatus(c, shop.ID, album.ID, pre.PhotoID, "ready", 30*time.Second)
	before := shopStorageUsed(c, shop.ID)
	for _, tc := range []struct {
		name    string
		data    []byte
		chunked bool
	}{
		{"larger-after-ready", bytes.Repeat([]byte{'x'}, 11<<20), false},
		{"smaller-after-ready", original[:len(original)-1], false},
		{"missing-length", original, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if status := put(tc.data, tc.chunked); status != http.StatusForbidden && (!tc.chunked || status != http.StatusLengthRequired) {
				t.Errorf("replay PUT: %d, want 403 (or 411 for missing length)", status)
			}
			size, exists, err := env.store.StatSize(t.Context(), "orig/"+shop.ID+"/"+pre.PhotoID)
			if err != nil || !exists || size != int64(len(original)) {
				t.Errorf("original size=%d, exists=%v, err=%v", size, exists, err)
			}
		})
		if status := put(original, false); status != http.StatusOK {
			t.Fatalf("same-size PUT: %d", status)
		}
	}
	if got := shopStorageUsed(c, shop.ID); got != before {
		t.Errorf("quota changed: %d, want %d", got, before)
	}
	if !strings.Contains(signed.Query().Get("X-Amz-SignedHeaders"), "content-length") {
		t.Error("Content-Length is not signed")
	}

	var logo struct {
		URL string `json:"url"`
	}
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/logo/presign", map[string]int{"size": len(original)}, http.StatusOK, &logo)
	signed, err = url.Parse(logo.URL)
	if err != nil {
		t.Fatal(err)
	}
	if status := put(original, false); status != http.StatusOK {
		t.Fatalf("logo PUT: %d", status)
	}
	if status := put(bytes.Repeat([]byte{'x'}, 11<<20), false); status != http.StatusForbidden {
		t.Errorf("oversized logo PUT: %d, want 403", status)
	}
	if !strings.Contains(signed.Query().Get("X-Amz-SignedHeaders"), "content-length") {
		t.Error("logo Content-Length is not signed")
	}
}

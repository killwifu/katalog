// Command seed — сидинг демо-магазина через публичное API и e2e-проверка
// витрины: «загрузил фото -> витрина обновилась ≤ 60 сек» (ISR-вебхук +
// TTL-фолбэк). Используется в CI (job storefront-e2e) и для локальной отладки.
//
// Требует запущенный стек (make up): api, worker, storefront, caddy.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"time"
)

type client struct {
	base string
	http *http.Client
}

func main() {
	api := flag.String("api", "http://localhost", "базовый URL API (через caddy)")
	storefront := flag.String("storefront", "http://localhost", "базовый URL витрины (через caddy)")
	photos := flag.Int("photos", 12, "сколько фото загрузить при сидинге")
	e2e := flag.Bool("e2e", false, "прогнать проверку «фото на витрине ≤ 60 сек»")
	out := flag.String("out", "", "файл для JSON-результата (по умолчанию stdout)")
	flag.Parse()

	jar, err := cookiejar.New(nil)
	if err != nil {
		log.Fatalf("cookie jar: %v", err)
	}
	c := &client{base: *api, http: &http.Client{Jar: jar, Timeout: 30 * time.Second}}

	suffix := time.Now().UnixNano() % 1_000_000
	email := fmt.Sprintf("seed%d@demo.local", suffix)
	slug := fmt.Sprintf("demo-%d", suffix)

	c.must("POST", "/api/v1/auth/register",
		map[string]string{"email": email, "password": "seed-password-1"}, nil)

	var shop struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
	}
	c.must("POST", "/api/v1/shops", map[string]any{
		"slug":        slug,
		"name":        "Демо-магазин",
		"description": "Сидовый магазин для e2e и Lighthouse CI",
		"contacts":    map[string]string{"telegram": "demo_shop", "whatsapp": "79990000000"},
	}, &shop)
	c.must("PATCH", "/api/v1/shops/"+shop.ID, map[string]any{
		"settings": map[string]string{"msg_template": "Здравствуйте! Интересует: {caption}"},
	}, nil)

	var album struct {
		ID string `json:"id"`
	}
	c.must("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Каталог"}, &album)

	log.Printf("seeding %d photos into %s/%s", *photos, shop.Slug, album.ID)
	var ids []string
	for i := range *photos {
		id := c.uploadPhoto(shop.ID, album.ID, i)
		c.must("PATCH", "/api/v1/photos/"+id,
			map[string]string{"caption": fmt.Sprintf("Товар %d, арт. A-%03d", i+1, i+1)}, nil)
		ids = append(ids, id)
	}
	c.waitReady(shop.ID, album.ID, ids, 120*time.Second)
	log.Printf("all %d photos ready", len(ids))

	shopURL := fmt.Sprintf("%s/%s", strings.TrimRight(*storefront, "/"), shop.Slug)
	albumURL := fmt.Sprintf("%s/a/%s", shopURL, album.ID)

	if *e2e {
		runE2E(c, shop.ID, album.ID, albumURL)
	}

	result, _ := json.MarshalIndent(map[string]string{
		"slug":      shop.Slug,
		"shop_id":   shop.ID,
		"album_id":  album.ID,
		"shop_url":  shopURL,
		"album_url": albumURL,
	}, "", "  ")
	if *out != "" {
		if err := os.WriteFile(*out, result, 0o644); err != nil {
			log.Fatalf("write %s: %v", *out, err)
		}
	}
	fmt.Println(string(result))
}

// runE2E: прогреть ISR-кеш страницы альбома -> загрузить новое фото ->
// дождаться его появления на витрине не позже чем через 60 сек.
func runE2E(c *client, shopID, albumID, albumURL string) {
	if _, err := fetchPage(albumURL); err != nil {
		log.Fatalf("e2e: warm storefront page: %v", err)
	}
	log.Printf("e2e: storefront page warmed (ISR cache populated)")

	start := time.Now()
	newID := c.uploadPhoto(shopID, albumID, 999)
	c.must("PATCH", "/api/v1/photos/"+newID, map[string]string{"caption": "E2E-товар"}, nil)
	log.Printf("e2e: new photo %s confirmed, polling storefront", newID)

	deadline := start.Add(60 * time.Second)
	for time.Now().Before(deadline) {
		html, err := fetchPage(albumURL)
		if err == nil && strings.Contains(html, newID) {
			log.Printf("e2e OK: photo visible on storefront in %s", time.Since(start).Round(time.Second))
			return
		}
		time.Sleep(2 * time.Second)
	}
	log.Fatalf("e2e FAILED: photo %s not visible on %s within 60s", newID, albumURL)
}

func fetchPage(url string) (string, error) {
	resp, err := http.Get(url) //nolint:gosec // локальный e2e URL
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	return string(body), nil
}

func (c *client) must(method, path string, body any, out any) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			log.Fatalf("marshal %s %s: %v", method, path, err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		log.Fatalf("build %s %s: %v", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		log.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		log.Fatalf("%s %s: status %d: %s", method, path, resp.StatusCode, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			log.Fatalf("%s %s: decode %q: %v", method, path, raw, err)
		}
	}
}

// uploadPhoto: presign -> PUT напрямую в S3 -> confirm.
func (c *client) uploadPhoto(shopID, albumID string, seed int) string {
	data := makeJPEG(seed)
	var pre struct {
		PhotoID string `json:"photo_id"`
		URL     string `json:"url"`
	}
	c.must("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shopID, "album_id": albumID, "size": len(data)}, &pre)

	putReq, err := http.NewRequest(http.MethodPut, pre.URL, bytes.NewReader(data))
	if err != nil {
		log.Fatalf("build PUT: %v", err)
	}
	resp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		log.Fatalf("PUT presigned: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		log.Fatalf("PUT presigned: status %d: %s", resp.StatusCode, raw)
	}

	var confirm struct {
		Results []struct {
			Status string `json:"status"`
			Error  string `json:"error"`
		} `json:"results"`
	}
	c.must("POST", "/api/v1/photos/confirm",
		map[string]any{"shop_id": shopID, "photo_ids": []string{pre.PhotoID}}, &confirm)
	if len(confirm.Results) != 1 || confirm.Results[0].Status != "processing" {
		log.Fatalf("confirm %s: %+v", pre.PhotoID, confirm.Results)
	}
	return pre.PhotoID
}

func (c *client) waitReady(shopID, albumID string, ids []string, timeout time.Duration) {
	pending := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		pending[id] = struct{}{}
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var page struct {
			Photos []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"photos"`
		}
		c.must("GET", "/api/v1/shops/"+shopID+"/albums/"+albumID+"/photos", nil, &page)
		for _, p := range page.Photos {
			switch p.Status {
			case "ready":
				delete(pending, p.ID)
			case "failed":
				log.Fatalf("photo %s failed processing", p.ID)
			}
		}
		if len(pending) == 0 {
			return
		}
		time.Sleep(time.Second)
	}
	log.Fatalf("%d photos not ready within %s", len(pending), timeout)
}

// makeJPEG — детерминированный градиентный JPEG 1200x900 (только stdlib).
func makeJPEG(seed int) []byte {
	const w, h = 1200, 900
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{
				R: uint8((x + seed*37) * 255 / w),
				G: uint8((y + seed*61) * 255 / h),
				B: uint8(((x + y) / 2) * 255 / ((w + h) / 2)),
				A: 255,
			})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85}); err != nil {
		log.Fatalf("encode jpeg: %v", err)
	}
	return buf.Bytes()
}

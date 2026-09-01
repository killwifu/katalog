package integration

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/http/cookiejar"
	"sync/atomic"
	"testing"
	"time"

	"github.com/davidbyttow/govips/v2/vips"
)

var clientSeq atomic.Int64

// client — HTTP-клиент теста: cookie jar (сессия) и уникальный фейковый IP
// (X-Forwarded-For), чтобы rate-limit тестов не пересекался.
type client struct {
	t    *testing.T
	http *http.Client
	ip   string
}

func newClient(t *testing.T) *client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	n := clientSeq.Add(1)
	return &client{
		t:    t,
		http: &http.Client{Jar: jar, Timeout: 15 * time.Second},
		ip:   fmt.Sprintf("10.7.%d.%d", (n>>8)&255, n&255),
	}
}

func (c *client) do(method, path string, body any) (int, []byte) {
	c.t.Helper()
	return c.doWithXFF(method, path, body, c.ip)
}

// doWithXFF — запрос с заданным X-Forwarded-For целиком: нужен, чтобы
// проверить разбор цепочки прокси, а не только одиночный адрес.
func (c *client) doWithXFF(method, path string, body any, xff string) (int, []byte) {
	c.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			c.t.Fatalf("marshal request: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, env.srv.URL+path, reader)
	if err != nil {
		c.t.Fatalf("build request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-Forwarded-For", xff)
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		c.t.Fatalf("read response: %v", err)
	}
	return resp.StatusCode, raw
}

// mustJSON выполняет запрос, проверяет статус и декодирует ответ в out.
func (c *client) mustJSON(method, path string, body any, wantStatus int, out any) {
	c.t.Helper()
	status, raw := c.do(method, path, body)
	if status != wantStatus {
		c.t.Fatalf("%s %s: status %d, want %d; body: %s", method, path, status, wantStatus, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			c.t.Fatalf("%s %s: decode response %q: %v", method, path, raw, err)
		}
	}
}

type userJSON struct {
	ID    string  `json:"id"`
	Email *string `json:"email"`
}

type shopJSON struct {
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	StorageUsed int64  `json:"storage_used"`
	StorageMax  int64  `json:"storage_max"`
}

type albumJSON struct {
	ID         string  `json:"id"`
	ParentID   *string `json:"parent_id"`
	Title      string  `json:"title"`
	PhotoCount int32   `json:"photo_count"`
}

type photoJSON struct {
	ID         string            `json:"id"`
	AlbumID    string            `json:"album_id"`
	Caption    string            `json:"caption"`
	Status     string            `json:"status"`
	Width      int32             `json:"width"`
	Height     int32             `json:"height"`
	Urls       map[string]string `json:"urls"`
	FailReason string            `json:"fail_reason"`
}

type presignJSON struct {
	PhotoID string `json:"photo_id"`
	URL     string `json:"url"`
}

func uniqueEmail() string {
	return fmt.Sprintf("user%d@test.local", clientSeq.Add(1))
}

func uniqueSlug() string {
	return fmt.Sprintf("shop-%d", clientSeq.Add(1))
}

func registerUser(c *client) userJSON {
	c.t.Helper()
	var u userJSON
	c.mustJSON("POST", "/api/v1/auth/register",
		map[string]string{"email": uniqueEmail(), "password": "password123"},
		http.StatusCreated, &u)
	return u
}

func createShop(c *client) shopJSON {
	c.t.Helper()
	var s shopJSON
	c.mustJSON("POST", "/api/v1/shops",
		map[string]any{"slug": uniqueSlug(), "name": "Test Shop"},
		http.StatusCreated, &s)
	return s
}

func createAlbum(c *client, shopID string) albumJSON {
	c.t.Helper()
	var al albumJSON
	c.mustJSON("POST", "/api/v1/shops/"+shopID+"/albums",
		map[string]any{"title": "Каталог"},
		http.StatusCreated, &al)
	return al
}

// uploadPhoto проходит presign -> PUT в MinIO -> confirm, возвращает photo_id.
func uploadPhoto(c *client, shopID, albumID string, data []byte) string {
	c.t.Helper()
	var pre presignJSON
	c.mustJSON("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shopID, "album_id": albumID, "size": len(data)},
		http.StatusOK, &pre)

	putReq, err := http.NewRequest(http.MethodPut, pre.URL, bytes.NewReader(data))
	if err != nil {
		c.t.Fatalf("build PUT: %v", err)
	}
	resp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		c.t.Fatalf("PUT to presigned url: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		c.t.Fatalf("PUT to presigned url: status %d: %s", resp.StatusCode, body)
	}

	var confirm struct {
		Results []struct {
			PhotoID string `json:"photo_id"`
			Status  string `json:"status"`
			Error   string `json:"error"`
		} `json:"results"`
	}
	c.mustJSON("POST", "/api/v1/photos/confirm",
		map[string]any{"shop_id": shopID, "photo_ids": []string{pre.PhotoID}},
		http.StatusOK, &confirm)
	if len(confirm.Results) != 1 || confirm.Results[0].Status != "processing" {
		c.t.Fatalf("confirm: unexpected results %+v", confirm.Results)
	}
	return pre.PhotoID
}

// waitPhotoStatus ждёт целевого статуса фото, опрашивая список альбома.
func waitPhotoStatus(c *client, shopID, albumID, photoID, want string, timeout time.Duration) photoJSON {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	var last photoJSON
	for time.Now().Before(deadline) {
		var page struct {
			Photos []photoJSON `json:"photos"`
		}
		c.mustJSON("GET", "/api/v1/shops/"+shopID+"/albums/"+albumID+"/photos", nil, http.StatusOK, &page)
		photos := page.Photos
		for _, p := range photos {
			if p.ID == photoID {
				last = p
				if p.Status == want {
					return p
				}
				if p.Status == "failed" && want != "failed" {
					c.t.Fatalf("photo %s failed while waiting for %s", photoID, want)
				}
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	c.t.Fatalf("photo %s did not reach status %q in %s (last: %+v)", photoID, want, timeout, last)
	return last
}

// makeJPEG генерирует настоящий JPEG заданного размера через govips.
func makeJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	img, err := vips.Black(width, height)
	if err != nil {
		t.Fatalf("vips black: %v", err)
	}
	defer img.Close()
	params := vips.NewJpegExportParams()
	params.Quality = 85
	buf, _, err := img.ExportJpeg(params)
	if err != nil {
		t.Fatalf("export jpeg: %v", err)
	}
	return buf
}

// makePNGBomb — PNG-заголовок с гигантскими размерами (декомпрессионная
// бомба): файл крошечный, заявленное разрешение — сотни мегапикселей.
func makePNGBomb(width, height uint32) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], width)
	binary.BigEndian.PutUint32(ihdr[4:8], height)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 2 // color type: truecolor
	writePNGChunk(&buf, "IHDR", ihdr)
	writePNGChunk(&buf, "IDAT", []byte{0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01})
	writePNGChunk(&buf, "IEND", nil)
	return buf.Bytes()
}

func writePNGChunk(buf *bytes.Buffer, name string, data []byte) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(data)))
	buf.Write(length[:])
	buf.WriteString(name)
	buf.Write(data)
	crc := crc32.NewIEEE()
	crc.Write([]byte(name))
	crc.Write(data)
	var crcBytes [4]byte
	binary.BigEndian.PutUint32(crcBytes[:], crc.Sum32())
	buf.Write(crcBytes[:])
}

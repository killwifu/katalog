package integration

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"sync"
	"testing"
)

// TestPhotoQuotaUnderConcurrency: лимит фотографий не обходится
// параллельными presign. Проверка и вставка раньше шли двумя запросами,
// и одновременные загрузки читали один и тот же счётчик: десять запросов
// на границе лимита проходили все десять.
func TestPhotoQuotaUnderConcurrency(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	// Лимит тарифа free в тестовой конфигурации — 8 фотографий.
	// Гонка вероятностная: в одном залпе горутины могут не пересечься.
	// Поэтому залпов несколько, и перед каждым состояние возвращается
	// ровно к «одно свободное место» — иначе второй и третий залпы просто
	// упираются в уже переполненную квоту и ничего не проверяют.
	const bursts = 3
	const parallel = 12
	for burst := 0; burst < bursts; burst++ {
		reseedToOneFree(t, ctx, shop.ID, album.ID)
		granted := presignBurst(t, c, shop.ID, album.ID, parallel)
		if granted != 1 {
			t.Fatalf("залп %d: выдано presign %d, ожидался ровно 1", burst+1, granted)
		}
		if total := countShopPhotos(t, shop.ID); total > 8 {
			t.Fatalf("залп %d: фотографий %d при лимите 8", burst+1, total)
		}
	}
}

// reseedToOneFree приводит магазин к состоянию «7 из 8», то есть ровно
// одно свободное место под фотографию.
func reseedToOneFree(t *testing.T, ctx context.Context, shopID, albumID string) {
	t.Helper()
	if _, err := env.pool.Exec(ctx, `DELETE FROM photos WHERE shop_id = $1`, shopID); err != nil {
		t.Fatalf("clear photos: %v", err)
	}
	if _, err := env.pool.Exec(ctx, `
		INSERT INTO photos (shop_id, album_id, status)
		SELECT $1, $2, 'ready' FROM generate_series(1, 7)`, shopID, albumID); err != nil {
		t.Fatalf("seed photos: %v", err)
	}
}

// presignBurst выпускает parallel одновременных presign и возвращает,
// сколько из них получили разрешение.
func presignBurst(t *testing.T, c *client, shopID, albumID string, parallel int) int {
	t.Helper()
	var wg sync.WaitGroup
	var ready sync.WaitGroup
	start := make(chan struct{})
	codes := make([]int, parallel)
	clients := make([]*client, parallel)
	for i := range clients {
		// Свой клиент на горутину: cookie jar не потокобезопасен.
		clients[i] = newClient(t)
		clients[i].http.Jar = c.http.Jar
	}
	for i := 0; i < parallel; i++ {
		wg.Add(1)
		ready.Add(1)
		go func(i int) {
			defer wg.Done()
			ready.Done()
			// Барьер: без него горутины успевают отстреляться по очереди,
			// и гонки, ради которой тест написан, просто не случается.
			<-start
			codes[i], _ = clients[i].do("POST", "/api/v1/uploads/presign",
				map[string]any{"shop_id": shopID, "album_id": albumID, "size": 1024})
		}(i)
	}
	ready.Wait()
	close(start)
	wg.Wait()

	granted := 0
	for _, code := range codes {
		if code == http.StatusOK {
			granted++
		}
	}
	return granted
}

// TestStorageQuotaEnforcedOnConfirm: лимит хранилища нельзя перебрать,
// заказав ссылки на загрузку заранее.
//
// presign сверяет квоту с shops.storage_used, а байты туда попадают только
// на confirm — после того, как файл уже лежит в S3. Значит, пока не
// подтверждён ни один файл, счётчик стоит на месте, и все presign проходят
// проверку по одному и тому же значению. Дальше confirm квоту не проверял
// вовсе и просто прибавлял байты: магазин уезжал за лимит тарифа, а платит
// за это хранилище оператор.
func TestStorageQuotaEnforcedOnConfirm(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	album := createAlbum(c, shop.ID)

	jpeg := makeJPEG(t, 320, 240)
	size := int64(len(jpeg))

	// Лимит хранилища тарифа free в тестовой конфигурации — 1 ГиБ.
	// Оставляем места ровно на полтора файла: один влезает, два — нет.
	const maxStorage = 1 << 30
	mustExec(t, "UPDATE shops SET storage_used = $2 WHERE id = $1",
		shop.ID, maxStorage-size-size/2)

	// Обе ссылки заказаны до того, как подтверждён хоть один файл.
	first := presignAndPut(t, c, shop.ID, album.ID, jpeg)
	second := presignAndPut(t, c, shop.ID, album.ID, jpeg)

	var confirm struct {
		Results []struct {
			PhotoID string `json:"photo_id"`
			Status  string `json:"status"`
			Error   string `json:"error"`
		} `json:"results"`
	}
	c.mustJSON("POST", "/api/v1/photos/confirm",
		map[string]any{"shop_id": shop.ID, "photo_ids": []string{first, second}},
		http.StatusOK, &confirm)

	var accepted, rejected int
	for _, r := range confirm.Results {
		switch r.Status {
		case "processing":
			accepted++
		case "error":
			rejected++
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Errorf("подтверждено %d, отклонено %d — ожидались 1 и 1: %+v",
			accepted, rejected, confirm.Results)
	}

	var used int64
	if err := env.pool.QueryRow(ctx,
		"SELECT storage_used FROM shops WHERE id = $1", shop.ID).Scan(&used); err != nil {
		t.Fatalf("read storage_used: %v", err)
	}
	if used > maxStorage {
		t.Errorf("занято %d байт при лимите %d — квота перебрана на %d",
			used, int64(maxStorage), used-maxStorage)
	}
}

// presignAndPut — заказать ссылку и загрузить файл, но не подтверждать.
func presignAndPut(t *testing.T, c *client, shopID, albumID string, data []byte) string {
	t.Helper()
	var pre presignJSON
	c.mustJSON("POST", "/api/v1/uploads/presign",
		map[string]any{"shop_id": shopID, "album_id": albumID, "size": len(data)},
		http.StatusOK, &pre)

	req, err := http.NewRequest(http.MethodPut, pre.URL, bytes.NewReader(data))
	if err != nil {
		t.Fatalf("build PUT: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT to presigned url: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT to presigned url: status %d: %s", resp.StatusCode, body)
	}
	return pre.PhotoID
}

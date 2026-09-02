package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"katalog/backend/internal/mail"
)

// captureMail — mail.Sender для тестов: складывает письма в память.
type captureMail struct {
	mu   sync.Mutex
	msgs []mail.Message
}

func newCaptureMail() *captureMail {
	return &captureMail{}
}

func (c *captureMail) Send(_ context.Context, msg mail.Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.msgs = append(c.msgs, msg)
	return nil
}

// waitEmail ждёт письмо адресату с подстрокой в теме (письма шлёт воркер
// асинхронно через email:send).
func waitEmail(t *testing.T, to, subjectPart string) mail.Message {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		env.mail.mu.Lock()
		for _, m := range env.mail.msgs {
			if m.To == to && strings.Contains(m.Subject, subjectPart) {
				env.mail.mu.Unlock()
				return m
			}
		}
		env.mail.mu.Unlock()
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("email to %s with subject %q not received", to, subjectPart)
	return mail.Message{}
}

// makeAdmin повышает пользователя до роли admin напрямую в БД.
func makeAdmin(t *testing.T, userID string) {
	t.Helper()
	mustExec(t, "UPDATE users SET role = 'admin' WHERE id = $1", userID)
}

type complaintJSON struct {
	ID           string  `json:"id"`
	ShopID       *string `json:"shop_id"`
	ShopSlug     *string `json:"shop_slug"`
	PhotoID      *string `json:"photo_id"`
	PhotoAlbumID *string `json:"photo_album_id"`
	Status       string  `json:"status"`
	ContentURL   string  `json:"content_url"`
}

// TestComplaintTakedownFlow: жалоба по URL фото -> письмо админу -> блокировка
// фото модератором: пропадает с витрины, деривативы удалены из S3 (оригинал
// остаётся), владелец уведомлён письмом, действие в аудит-логе.
func TestComplaintTakedownFlow(t *testing.T) {
	ctx := context.Background()
	owner := newClient(t)
	ownerUser := registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	photoID := uploadPhoto(owner, shop.ID, album.ID, makeJPEG(t, 640, 480))
	waitPhotoStatus(owner, shop.ID, album.ID, photoID, "ready", 60*time.Second)

	// Жалоба без auth по прямому URL картинки.
	reporter := newClient(t)
	var created struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	reporter.mustJSON("POST", "/api/v1/public/complaints", map[string]string{
		"url":            "http://katalog.test/media/" + shop.ID + "/" + photoID + "/800.webp",
		"reporter_name":  "ООО Правообладатель",
		"reporter_email": "legal@brand.test",
		"reason":         "Фото нарушает наши исключительные права на товарный знак.",
	}, http.StatusCreated, &created)
	if created.Status != "open" {
		t.Fatalf("new complaint status: %s", created.Status)
	}
	adminNote := waitEmail(t, "moderator@test.local", "новая жалоба")
	if !strings.Contains(adminNote.Text, created.ID) {
		t.Fatalf("admin email must reference complaint id, got: %s", adminNote.Text)
	}

	// Не-админу админ-зона недоступна (404, существование не раскрывается).
	if status, _ := owner.do("GET", "/api/v1/admin/complaints", nil); status != http.StatusNotFound {
		t.Fatalf("admin list as regular user: status %d, want 404", status)
	}

	adminClient := newClient(t)
	adminUser := registerUser(adminClient)
	makeAdmin(t, adminUser.ID)

	var complaints []complaintJSON
	adminClient.mustJSON("GET", "/api/v1/admin/complaints?status=open", nil, http.StatusOK, &complaints)
	var target *complaintJSON
	for i := range complaints {
		if complaints[i].ID == created.ID {
			target = &complaints[i]
		}
	}
	if target == nil {
		t.Fatalf("complaint %s not in admin list", created.ID)
	}
	// URL распознан: жалоба привязана к магазину и фото.
	if target.ShopID == nil || *target.ShopID != shop.ID ||
		target.PhotoID == nil || *target.PhotoID != photoID ||
		target.ShopSlug == nil || *target.ShopSlug != shop.Slug {
		t.Fatalf("complaint target not resolved: %+v", target)
	}

	// В работу -> блокировка фото -> жалоба решена.
	adminClient.mustJSON("PATCH", "/api/v1/admin/complaints/"+created.ID,
		map[string]string{"status": "in_review"}, http.StatusOK, nil)
	adminClient.mustJSON("POST", "/api/v1/admin/photos/"+photoID+"/block",
		map[string]string{"complaint_id": created.ID, "note": "нарушение ТЗ"}, http.StatusOK, nil)
	adminClient.mustJSON("PATCH", "/api/v1/admin/complaints/"+created.ID,
		map[string]string{"status": "resolved"}, http.StatusOK, nil)

	// Фото исчезло с витрины.
	var pub struct {
		Photos []struct {
			ID string `json:"id"`
		} `json:"photos"`
	}
	owner.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID, nil, http.StatusOK, &pub)
	if len(pub.Photos) != 0 {
		t.Fatalf("blocked photo still on storefront: %+v", pub.Photos)
	}
	// Деривативы удалены из S3, оригинал остался.
	for _, size := range []string{"300", "800", "1600"} {
		if _, exists, err := env.store.StatSize(ctx, "drv/"+shop.ID+"/"+photoID+"/"+size+".webp"); err != nil || exists {
			t.Fatalf("derivative %s: exists=%v err=%v, want removed", size, exists, err)
		}
	}
	if _, exists, err := env.store.StatSize(ctx, "orig/"+shop.ID+"/"+photoID); err != nil || !exists {
		t.Fatalf("original must be kept: exists=%v err=%v", exists, err)
	}
	// Владелец уведомлён.
	waitEmail(t, *ownerUser.Email, "фото скрыто модератором")

	// Аудит-лог: смена статусов + блокировка.
	var logCount int
	if err := env.pool.QueryRow(ctx,
		"SELECT count(*) FROM moderation_log WHERE complaint_id = $1", created.ID).Scan(&logCount); err != nil {
		t.Fatalf("count moderation log: %v", err)
	}
	if logCount != 3 {
		t.Fatalf("moderation log entries: %d, want 3", logCount)
	}

	// Повторная блокировка идемпотентна.
	adminClient.mustJSON("POST", "/api/v1/admin/photos/"+photoID+"/block", nil, http.StatusOK, nil)
}

// TestAdminHideAlbumAndSuspendShop: скрытие альбома и suspended магазина
// убирают контент с витрины; владелец получает письма; всё в аудит-логе.
func TestAdminHideAlbumAndSuspendShop(t *testing.T) {
	owner := newClient(t)
	ownerUser := registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)

	adminClient := newClient(t)
	adminUser := registerUser(adminClient)
	makeAdmin(t, adminUser.ID)

	adminClient.mustJSON("POST", "/api/v1/admin/albums/"+album.ID+"/hide", nil, http.StatusNoContent, nil)
	if status, _ := owner.do("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+album.ID, nil); status != http.StatusNotFound {
		t.Fatalf("hidden album on storefront: status %d, want 404", status)
	}
	waitEmail(t, *ownerUser.Email, "альбом скрыт")

	adminClient.mustJSON("POST", "/api/v1/admin/shops/"+shop.ID+"/suspend", nil, http.StatusNoContent, nil)
	if status, _ := owner.do("GET", "/api/v1/public/shops/"+shop.Slug, nil); status != http.StatusNotFound {
		t.Fatalf("suspended shop on storefront: status %d, want 404", status)
	}
	waitEmail(t, *ownerUser.Email, "магазин заблокирован")

	var actions []string
	rows, err := env.pool.Query(context.Background(),
		"SELECT action::text FROM moderation_log WHERE shop_id = $1 ORDER BY created_at", shop.ID)
	if err != nil {
		t.Fatalf("query moderation log: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			t.Fatalf("scan: %v", err)
		}
		actions = append(actions, a)
	}
	if len(actions) != 2 || actions[0] != "hide_album" || actions[1] != "suspend_shop" {
		t.Fatalf("moderation log actions: %v", actions)
	}
}

// TestStopWordsFlagging: стоп-слово в подписи -> флаг ручной проверки
// (не автоблок: фото остаётся ready и видно на витрине), админ видит его
// в списке и может снять флаг.
func TestStopWordsFlagging(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	photoID := uploadPhoto(owner, shop.ID, album.ID, makeJPEG(t, 320, 240))
	waitPhotoStatus(owner, shop.ID, album.ID, photoID, "ready", 60*time.Second)

	// Обычная подпись флага не ставит.
	owner.mustJSON("PATCH", "/api/v1/photos/"+photoID,
		map[string]string{"caption": "Кроссовки арт. 123"}, http.StatusOK, nil)
	var flagged bool
	mustQueryRow(t, "SELECT flagged FROM photos WHERE id = $1", &flagged, photoID)
	if flagged {
		t.Fatal("photo flagged without stop word")
	}

	// Стоп-слово (в тестовом конфиге: «контрафакт») -> флаг, но НЕ блок.
	var updated photoJSON
	owner.mustJSON("PATCH", "/api/v1/photos/"+photoID,
		map[string]string{"caption": "Настоящий КОНТРАФАКТ 1:1"}, http.StatusOK, &updated)
	if updated.Status != "ready" {
		t.Fatalf("stop word must not change status, got %s", updated.Status)
	}
	mustQueryRow(t, "SELECT flagged FROM photos WHERE id = $1", &flagged, photoID)
	if !flagged {
		t.Fatal("photo with stop word not flagged")
	}

	adminClient := newClient(t)
	adminUser := registerUser(adminClient)
	makeAdmin(t, adminUser.ID)

	var list []struct {
		ID      string `json:"id"`
		Caption string `json:"caption"`
	}
	adminClient.mustJSON("GET", "/api/v1/admin/photos/flagged", nil, http.StatusOK, &list)
	found := false
	for _, p := range list {
		if p.ID == photoID {
			found = true
		}
	}
	if !found {
		t.Fatalf("flagged photo %s not in admin list", photoID)
	}

	adminClient.mustJSON("POST", "/api/v1/admin/photos/"+photoID+"/unflag", nil, http.StatusNoContent, nil)
	mustQueryRow(t, "SELECT flagged FROM photos WHERE id = $1", &flagged, photoID)
	if flagged {
		t.Fatal("photo still flagged after unflag")
	}
}

// TestPasswordResetFlow: forgot -> письмо с токеном -> reset -> вход с новым
// паролем; старый пароль и повторное использование токена не работают.
func TestPasswordResetFlow(t *testing.T) {
	c := newClient(t)
	user := registerUser(c)
	email := *user.Email

	c.mustJSON("POST", "/api/v1/auth/password/forgot",
		map[string]string{"email": email}, http.StatusNoContent, nil)
	msg := waitEmail(t, email, "Сброс пароля")
	token := extractToken(t, msg.Text, "/app/reset-password?token=")

	c.mustJSON("POST", "/api/v1/auth/password/reset",
		map[string]string{"token": token, "password": "newpassword456"}, http.StatusNoContent, nil)

	// Старый пароль больше не подходит, новый — работает.
	fresh := newClient(t)
	if status, _ := fresh.do("POST", "/api/v1/auth/login",
		map[string]string{"email": email, "password": "password123"}); status != http.StatusUnauthorized {
		t.Fatalf("login with old password: status %d, want 401", status)
	}
	fresh.mustJSON("POST", "/api/v1/auth/login",
		map[string]string{"email": email, "password": "newpassword456"}, http.StatusOK, nil)

	// Токен одноразовый.
	if status, _ := fresh.do("POST", "/api/v1/auth/password/reset",
		map[string]string{"token": token, "password": "another12345"}); status != http.StatusBadRequest {
		t.Fatalf("reset with used token: status %d, want 400", status)
	}

	// Несуществующий email не раскрывается: тоже 204.
	fresh.mustJSON("POST", "/api/v1/auth/password/forgot",
		map[string]string{"email": "nobody@test.local"}, http.StatusNoContent, nil)
}

// TestEmailVerification: письмо при регистрации -> подтверждение -> флаг в /me.
func TestEmailVerification(t *testing.T) {
	c := newClient(t)
	user := registerUser(c)
	email := *user.Email

	msg := waitEmail(t, email, "Подтвердите регистрацию")
	token := extractToken(t, msg.Text, "/app/verify-email?token=")

	var me struct {
		EmailVerified bool `json:"email_verified"`
	}
	c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
	if me.EmailVerified {
		t.Fatal("email verified before confirmation")
	}

	c.mustJSON("POST", "/api/v1/auth/verify-email",
		map[string]string{"token": token}, http.StatusNoContent, nil)
	c.mustJSON("GET", "/api/v1/auth/me", nil, http.StatusOK, &me)
	if !me.EmailVerified {
		t.Fatal("email not verified after confirmation")
	}
}

// extractToken достаёт значение token из ссылки в тексте письма.
func extractToken(t *testing.T, text, marker string) string {
	t.Helper()
	i := strings.Index(text, marker)
	if i < 0 {
		t.Fatalf("marker %q not found in email: %s", marker, text)
	}
	rest := text[i+len(marker):]
	if j := strings.IndexAny(rest, " \n\r"); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

func mustQueryRow(t *testing.T, sql string, dst any, args ...any) {
	t.Helper()
	if err := env.pool.QueryRow(context.Background(), sql, args...).Scan(dst); err != nil {
		t.Fatalf("query %q: %v", sql, err)
	}
}

// TestModeratorBlockSurvivesSeller: блокировка альбома модератором держится.
// Раньше она была обычным статусом draft — то есть тем же полем, которым
// управляет сам продавец, и тот возвращал альбом на витрину одним запросом.
func TestModeratorBlockSurvivesSeller(t *testing.T) {
	ctx := context.Background()
	seller := newClient(t)
	registerUser(seller)
	shop := createShop(seller)
	album := createAlbum(seller, shop.ID)
	// С фотографией: пустой альбом витрина не показывает и без блокировки,
	// и проверка «скрытие пережило продавца» стала бы пустой.
	uploadReadyPhoto(t, seller, shop.ID, album.ID, makeJPEG(t, 320, 240))

	admin := newClient(t)
	adminUser := registerUser(admin)
	if _, err := env.pool.Exec(ctx,
		`UPDATE users SET role = 'admin' WHERE id = $1`, adminUser.ID); err != nil {
		t.Fatalf("promote admin: %v", err)
	}

	admin.mustJSON("POST", "/api/v1/admin/albums/"+album.ID+"/hide",
		map[string]any{"note": "жалоба правообладателя"}, http.StatusNoContent, nil)

	// Продавец пытается вернуть альбом на витрину.
	seller.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+album.ID,
		map[string]any{"status": "published"}, http.StatusOK, nil)

	var page struct {
		Albums []albumJSON `json:"albums"`
	}
	status, raw := seller.do("GET", "/api/v1/public/shops/"+shop.Slug, nil)
	if status != http.StatusOK {
		t.Fatalf("public shop: status %d; body: %s", status, raw)
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatalf("decode public shop: %v", err)
	}
	for _, a := range page.Albums {
		if a.ID == album.ID {
			t.Fatal("альбом, заблокированный модератором, вернулся на витрину")
		}
	}

	// Модератор может снять блокировку — жалоба бывает необоснованной.
	admin.mustJSON("POST", "/api/v1/admin/albums/"+album.ID+"/unhide",
		map[string]any{"note": "жалоба отклонена"}, http.StatusNoContent, nil)

	status, raw = seller.do("GET", "/api/v1/public/shops/"+shop.Slug, nil)
	if status != http.StatusOK {
		t.Fatalf("public shop after unhide: status %d", status)
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatalf("decode: %v", err)
	}
	var back bool
	for _, a := range page.Albums {
		if a.ID == album.ID {
			back = true
		}
	}
	if !back {
		t.Fatal("после снятия блокировки альбом не вернулся")
	}
}

// TestAdminUnsuspendShop: блокировку магазина можно снять. Обратного
// действия не было вовсе — ошибочная блокировка означала мёртвый магазин.
func TestAdminUnsuspendShop(t *testing.T) {
	ctx := context.Background()
	seller := newClient(t)
	registerUser(seller)
	shop := createShop(seller)

	admin := newClient(t)
	adminUser := registerUser(admin)
	if _, err := env.pool.Exec(ctx,
		`UPDATE users SET role = 'admin' WHERE id = $1`, adminUser.ID); err != nil {
		t.Fatalf("promote admin: %v", err)
	}

	admin.mustJSON("POST", "/api/v1/admin/shops/"+shop.ID+"/suspend",
		map[string]any{"note": "жалоба"}, http.StatusNoContent, nil)
	if status, _ := seller.do("GET", "/api/v1/public/shops/"+shop.Slug, nil); status == http.StatusOK {
		t.Fatal("витрина заблокированного магазина всё ещё открыта")
	}

	admin.mustJSON("POST", "/api/v1/admin/shops/"+shop.ID+"/unsuspend",
		map[string]any{"note": "жалоба отклонена"}, http.StatusNoContent, nil)
	if status, raw := seller.do("GET", "/api/v1/public/shops/"+shop.Slug, nil); status != http.StatusOK {
		t.Fatalf("после снятия блокировки витрина не открылась: status %d; body: %s", status, raw)
	}

	// Повторное снятие — уже не заблокирован.
	if status, _ := admin.do("POST", "/api/v1/admin/shops/"+shop.ID+"/unsuspend",
		map[string]any{"note": "повтор"}); status != http.StatusNotFound {
		t.Fatalf("повторное снятие: status %d, want 404", status)
	}
}

// TestPhotoBlockAndUnblock: блокировка возвращает байты деривативов в квоту,
// а снятие блокировки пересобирает фото. Раньше блокировка удаляла файлы
// из S3, но место за них продолжало числиться за продавцом, и обратного
// действия не было вовсе.
func TestPhotoBlockAndUnblock(t *testing.T) {
	ctx := context.Background()
	seller := newClient(t)
	registerUser(seller)
	shop := createShop(seller)
	album := createAlbum(seller, shop.ID)
	photoID := uploadPhoto(seller, shop.ID, album.ID, makeJPEG(t, 800, 600))
	waitPhotoStatus(seller, shop.ID, album.ID, photoID, "ready", 30*time.Second)

	admin := newClient(t)
	adminUser := registerUser(admin)
	if _, err := env.pool.Exec(ctx,
		`UPDATE users SET role = 'admin' WHERE id = $1`, adminUser.ID); err != nil {
		t.Fatalf("promote admin: %v", err)
	}

	var before, drv int64
	if err := env.pool.QueryRow(ctx,
		`SELECT s.storage_used, p.drv_size FROM shops s, photos p WHERE s.id = $1 AND p.id = $2`,
		shop.ID, photoID).Scan(&before, &drv); err != nil {
		t.Fatalf("read storage: %v", err)
	}
	if drv == 0 {
		t.Fatal("деривативы не учтены — тест ничего не проверит")
	}

	admin.mustJSON("POST", "/api/v1/admin/photos/"+photoID+"/block",
		map[string]any{"note": "жалоба"}, http.StatusOK, nil)

	var after int64
	if err := env.pool.QueryRow(ctx,
		`SELECT storage_used FROM shops WHERE id = $1`, shop.ID).Scan(&after); err != nil {
		t.Fatalf("read storage: %v", err)
	}
	if after != before-drv {
		t.Fatalf("квота после блокировки %d, ожидалось %d (было %d, деривативы %d)",
			after, before-drv, before, drv)
	}

	// Снятие блокировки отправляет фото на повторную обработку.
	admin.mustJSON("POST", "/api/v1/admin/photos/"+photoID+"/unblock",
		map[string]any{"note": "жалоба отклонена"}, http.StatusOK, nil)
	waitPhotoStatus(seller, shop.ID, album.ID, photoID, "ready", 30*time.Second)

	// Повторная обработка вернула байты обратно ровно один раз.
	if err := env.pool.QueryRow(ctx,
		`SELECT storage_used FROM shops WHERE id = $1`, shop.ID).Scan(&after); err != nil {
		t.Fatalf("read storage: %v", err)
	}
	if after != before {
		t.Fatalf("квота после снятия блокировки %d, ожидалось %d", after, before)
	}

	// Повторное снятие — фото уже не заблокировано.
	if status, _ := admin.do("POST", "/api/v1/admin/photos/"+photoID+"/unblock",
		map[string]any{"note": "повтор"}); status != http.StatusNotFound {
		t.Fatalf("повторное снятие: status %d, want 404", status)
	}
}

// TestComplaintResolvesProductionMediaURL: жалоба привязывается к фото и по
// тому адресу, который правообладатель реально скопирует в проде.
//
// Разбор ссылки опирался на первый сегмент пути («media»), а такой префикс
// бывает только локально: MEDIA_BASE_URL в проде — домен CDN или бакет S3
// (deploy/s3/setup.sh выдаёт .../{bucket}/drv). Там первый сегмент другой,
// жалоба оставалась без привязки, и модератор искал фото руками — при том
// что ссылка на него лежала прямо в жалобе.
func TestComplaintResolvesProductionMediaURL(t *testing.T) {
	owner := newClient(t)
	registerUser(owner)
	shop := createShop(owner)
	album := createAlbum(owner, shop.ID)
	photoID := uploadPhoto(owner, shop.ID, album.ID, makeJPEG(t, 320, 240))
	waitPhotoStatus(owner, shop.ID, album.ID, photoID, "ready", 60*time.Second)

	adminClient := newClient(t)
	adminUser := registerUser(adminClient)
	makeAdmin(t, adminUser.ID)

	cases := map[string]string{
		"бакет S3 (deploy/s3/setup.sh)": "https://storage.yandexcloud.net/katalog/drv/" +
			shop.ID + "/" + photoID + "/800.webp",
		"домен CDN": "https://cdn.katalog.test/drv/" + shop.ID + "/" + photoID + "/300.webp",
		"локальная раскладка": "http://katalog.test/media/" +
			shop.ID + "/" + photoID + "/1600.webp",
	}

	for name, url := range cases {
		t.Run(name, func(t *testing.T) {
			reporter := newClient(t)
			var created struct {
				ID string `json:"id"`
			}
			reporter.mustJSON("POST", "/api/v1/public/complaints", map[string]string{
				"url":            url,
				"reporter_name":  "ООО Правообладатель",
				"reporter_email": "legal@brand.test",
				"reason":         "Фотография нарушает наши исключительные права.",
			}, http.StatusCreated, &created)

			var complaints []complaintJSON
			adminClient.mustJSON("GET", "/api/v1/admin/complaints?status=open",
				nil, http.StatusOK, &complaints)
			var target *complaintJSON
			for i := range complaints {
				if complaints[i].ID == created.ID {
					target = &complaints[i]
				}
			}
			if target == nil {
				t.Fatalf("жалоба %s не найдена в списке админа", created.ID)
			}
			if target.PhotoID == nil || *target.PhotoID != photoID {
				t.Errorf("фото не распознано в адресе %s: %+v", url, target)
			}
			if target.ShopID == nil || *target.ShopID != shop.ID {
				t.Errorf("магазин не распознан в адресе %s: %+v", url, target)
			}
		})
	}
}

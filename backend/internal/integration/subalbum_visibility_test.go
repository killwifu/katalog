package integration

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// TestSubAlbumHiddenWithParent: подальбом не виднее родителя. Раньше
// видимость проверялась только по строке самого альбома, и подальбом
// скрытого родителя открывался по прямой ссылке (его id отдавала главная
// магазина), находился поиском и висел в выдаче — в том числе после
// снятия родителя модератором по жалобе и после скрытия тарифом.
func TestSubAlbumHiddenWithParent(t *testing.T) {
	cases := []struct {
		name  string
		apply func(t *testing.T, c *client, shopID, parentID string)
	}{
		{"черновик", func(t *testing.T, c *client, shopID, parentID string) {
			c.mustJSON("PATCH", "/api/v1/shops/"+shopID+"/albums/"+parentID, map[string]any{"status": "draft"}, http.StatusOK, nil)
		}},
		{"модератор", func(t *testing.T, _ *client, _, parentID string) {
			mustExec(t, "UPDATE albums SET blocked_by_moderator = true WHERE id = $1", parentID)
		}},
		{"тариф", func(t *testing.T, _ *client, _, parentID string) {
			mustExec(t, "UPDATE albums SET hidden_by_plan = true WHERE id = $1", parentID)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newClient(t)
			registerUser(c)
			shop := createShop(c)
			parent := createAlbum(c, shop.ID)
			var child albumJSON
			c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums",
				map[string]any{"title": "Ветка", "parent_id": parent.ID}, http.StatusCreated, &child)
			photoID := uploadReadyPhoto(t, c, shop.ID, child.ID, makeJPEG(t, 320, 240))
			setCaption(c, photoID, "Пальто ветковое")

			tc.apply(t, c, shop.ID, parent.ID)

			buyer := newClient(t)
			if status, body := buyer.do("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+child.ID, nil); status != http.StatusNotFound {
				t.Errorf("подальбом по прямой ссылке: %d %s", status, body)
			}
			_, home := buyer.do("GET", "/api/v1/public/shops/"+shop.Slug, nil)
			if strings.Contains(string(home), child.ID) {
				t.Errorf("подальбом на главной магазина: %s", home)
			}
			_, found := buyer.do("GET", "/api/v1/public/shops/"+shop.Slug+"/search?q="+url.QueryEscape("пальто"), nil)
			if strings.Contains(string(found), photoID) {
				t.Errorf("фото подальбома в поиске: %s", found)
			}
		})
	}
}

// TestSubAlbumLockedByParentPassword: пароль родителя закрывает и подальбом
// без своего пароля, а пропуск родителя его открывает.
func TestSubAlbumLockedByParentPassword(t *testing.T) {
	c := newClient(t)
	registerUser(c)
	shop := createShop(c)
	mustExec(t, "UPDATE shops SET plan = 'basic', paid_until = now() + interval '30 days' WHERE id = $1", shop.ID)
	parent := createAlbum(c, shop.ID)
	var child albumJSON
	c.mustJSON("POST", "/api/v1/shops/"+shop.ID+"/albums",
		map[string]any{"title": "Ветка", "parent_id": parent.ID}, http.StatusCreated, &child)
	photoID := uploadReadyPhoto(t, c, shop.ID, child.ID, makeJPEG(t, 320, 240))
	setCaption(c, photoID, "Пальто ветковое")
	c.mustJSON("PATCH", "/api/v1/shops/"+shop.ID+"/albums/"+parent.ID, map[string]any{"password": "opt2026"}, http.StatusOK, nil)

	buyer := newClient(t)
	childPath := "/api/v1/public/shops/" + shop.Slug + "/albums/" + child.ID
	var page pubAlbumPage
	buyer.mustJSON("GET", childPath, nil, http.StatusOK, &page)
	if !page.Album.Locked || len(page.Photos) != 0 {
		t.Fatalf("подальбом закрытого родителя открыт без пароля: %+v", page)
	}
	_, found := buyer.do("GET", "/api/v1/public/shops/"+shop.Slug+"/search?q="+url.QueryEscape("пальто"), nil)
	if strings.Contains(string(found), photoID) {
		t.Errorf("фото подальбома закрытого родителя в поиске: %s", found)
	}

	// Пароль родителя, введённый на странице подальбома, открывает его.
	var pass struct {
		Token string `json:"token"`
	}
	buyer.mustJSON("POST", childPath+"/unlock", map[string]any{"password": "opt2026"}, http.StatusOK, &pass)
	buyer.headers = map[string]string{"X-Album-Token": pass.Token}
	var opened pubAlbumPage
	buyer.mustJSON("GET", childPath, nil, http.StatusOK, &opened)
	if opened.Album.Locked || len(opened.Photos) != 1 {
		t.Fatalf("пропуск не открыл подальбом: %+v", opened)
	}
	// И это тот же пропуск, что у родителя.
	var parentPage pubAlbumPage
	buyer.mustJSON("GET", "/api/v1/public/shops/"+shop.Slug+"/albums/"+parent.ID, nil, http.StatusOK, &parentPage)
	if parentPage.Album.Locked {
		t.Errorf("пропуск подальбома не открыл родителя")
	}
}

package integration

import (
	"net/http"
	"strings"
	"testing"
)

func TestAdminComplaintsPagination(t *testing.T) {
	admin := newClient(t)
	user := registerUser(admin)
	makeAdmin(t, user.ID)
	// Set-based fixture; tied timestamps exercise stable ordering.
	mustExec(t, `INSERT INTO complaints (reason, reporter_name, reporter_email, content_url, status, created_at)
 SELECT 'pagination-' || n, 'Reporter', 'qa@test.local', 'https://example.test', 'rejected', '2100-01-01'::timestamptz
 FROM generate_series(1, 205) n`)
	t.Cleanup(func() { mustExec(t, "DELETE FROM complaints WHERE reporter_email = 'qa@test.local'") })
	get := func(query string) []struct{ ID, Reason, Status string } {
		var out []struct{ ID, Reason, Status string }
		admin.mustJSON("GET", "/api/v1/admin/complaints"+query, nil, http.StatusOK, &out)
		return out
	}
	first := get("?status=rejected")
	if len(first) != 200 {
		t.Fatalf("first page: %d", len(first))
	}
	explicit := get("?status=rejected&page=1")
	for i := range first {
		if first[i].ID != explicit[i].ID {
			t.Fatal("default is not page 1")
		}
	}
	seen := map[string]bool{}
	for _, c := range first {
		seen[c.ID] = true
	}
	second := get("?status=rejected&page=2")
	count := len(first)
	for _, c := range second {
		if seen[c.ID] {
			t.Fatalf("duplicate on page 2: %s", c.ID)
		}
		if c.Status != "rejected" {
			t.Fatalf("wrong status: %s", c.Status)
		}
		if strings.HasPrefix(c.Reason, "pagination-") {
			count++
		}
	}
	if count != 205 {
		t.Fatalf("fixture complaints reached: %d, want 205", count)
	}
	if all := get("?page=2"); len(all) < 5 {
		t.Fatalf("unfiltered page 2: %d", len(all))
	}
	if far := get("?status=rejected&page=1000000"); len(far) != 0 {
		t.Fatalf("far page: %d", len(far))
	}
	for _, page := range []string{"0", "-1", "bad"} {
		got := get("?status=rejected&page=" + page)
		if len(got) != len(first) || got[0].ID != first[0].ID {
			t.Fatalf("invalid page %s should default to 1", page)
		}
	}
	anon := newClient(t)
	anon.mustJSON("GET", "/api/v1/admin/complaints?page=2", nil, http.StatusUnauthorized, nil)
	normal := newClient(t)
	registerUser(normal)
	normal.mustJSON("GET", "/api/v1/admin/complaints?page=2", nil, http.StatusNotFound, nil)
	admin.mustJSON("GET", "/api/v1/admin/complaints?status=invalid&page=2", nil, http.StatusBadRequest, nil)
}

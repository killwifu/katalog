package api

import "testing"

func TestValidateSlug(t *testing.T) {
	tests := []struct {
		name   string
		slug   string
		wantOK bool
	}{
		{name: "simple", slug: "nike-store", wantOK: true},
		{name: "digits", slug: "shop123", wantOK: true},
		{name: "min length", slug: "abc", wantOK: true},
		{name: "too short", slug: "ab", wantOK: false},
		{name: "too long", slug: "a234567890123456789012345678901234567890123456789012345678901234", wantOK: false},
		{name: "uppercase", slug: "Nike", wantOK: false},
		{name: "cyrillic", slug: "магазин", wantOK: false},
		{name: "leading hyphen", slug: "-shop", wantOK: false},
		{name: "trailing hyphen", slug: "shop-", wantOK: false},
		{name: "double hyphen", slug: "ni--ke", wantOK: false},
		{name: "space", slug: "my shop", wantOK: false},
		{name: "reserved admin", slug: "admin", wantOK: false},
		{name: "reserved api", slug: "api", wantOK: false},
		{name: "reserved app", slug: "app", wantOK: false},
		{name: "reserved media", slug: "media", wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := validateSlug(tt.slug)
			if ok := msg == ""; ok != tt.wantOK {
				t.Errorf("validateSlug(%q) = %q, want ok=%v", tt.slug, msg, tt.wantOK)
			}
		})
	}
}

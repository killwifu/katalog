package imagingmeta

import (
	"slices"
	"testing"
)

func TestWatermarkCells(t *testing.T) {
	for _, tc := range []struct {
		pos  string
		want []string
	}{
		{"", []string{"br"}},
		{"tl", []string{"tl"}},
		{"tl,br,mc", []string{"tl", "br", "mc"}},
		{"tile", []string{"tile"}},
		{"tl,tl", nil},
		{"tl,tile", nil},
		{"xx", nil},
		{"tl,", nil},
	} {
		got, ok := WatermarkCells(tc.pos)
		if ok != (tc.want != nil) || !slices.Equal(got, tc.want) {
			t.Errorf("WatermarkCells(%q) = %v, %v; want %v", tc.pos, got, ok, tc.want)
		}
	}
}

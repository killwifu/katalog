package api

import "testing"

func TestHasEscapedNUL(t *testing.T) {
	tests := []struct {
		name string
		body string
		want bool
	}{
		{"нет", `{"title":"Кроссовки"}`, false},
		{"NUL", `{"title":"a\u0000b"}`, true},
		{"текст \\u0000 с экранированной косой", `{"title":"a\\u0000b"}`, false},
		{"три косые — снова NUL", `{"title":"a\\\u0000b"}`, true},
		{"второе вхождение", `{"a":"\\u0000","b":"\u0000"}`, true},
		{"другой код", `{"title":"\u0001"}`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hasEscapedNUL([]byte(tt.body)); got != tt.want {
				t.Fatalf("hasEscapedNUL(%s) = %v, want %v", tt.body, got, tt.want)
			}
		})
	}
}

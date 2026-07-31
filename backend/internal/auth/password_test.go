package auth

import (
	"strings"
	"testing"
)

func TestHashAndVerifyPassword(t *testing.T) {
	tests := []struct {
		name     string
		password string
		check    string
		want     bool
	}{
		{name: "correct password", password: "s3cret-password", check: "s3cret-password", want: true},
		{name: "wrong password", password: "s3cret-password", check: "other", want: false},
		{name: "unicode password", password: "пароль-密码", check: "пароль-密码", want: true},
		{name: "empty check", password: "s3cret-password", check: "", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hash, err := HashPassword(tt.password)
			if err != nil {
				t.Fatalf("HashPassword: %v", err)
			}
			if !strings.HasPrefix(hash, "$argon2id$") {
				t.Fatalf("hash has wrong format: %s", hash)
			}
			got, err := VerifyPassword(tt.check, hash)
			if err != nil {
				t.Fatalf("VerifyPassword: %v", err)
			}
			if got != tt.want {
				t.Errorf("VerifyPassword(%q) = %v, want %v", tt.check, got, tt.want)
			}
		})
	}
}

func TestVerifyPasswordInvalidHash(t *testing.T) {
	for _, bad := range []string{"", "plain", "$argon2i$v=19$m=1,t=1,p=1$YQ$YQ", "$argon2id$broken"} {
		if _, err := VerifyPassword("x", bad); err == nil {
			t.Errorf("VerifyPassword with hash %q: want error, got nil", bad)
		}
	}
}

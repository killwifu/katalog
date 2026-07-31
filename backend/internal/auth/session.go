package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	SessionCookie = "katalog_session"
	sessionPrefix = "sess:"
)

var ErrNoSession = errors.New("auth: session not found")

// Sessions хранит сессии в Redis: sess:{token} -> user_id, sliding TTL.
type Sessions struct {
	rdb *redis.Client
	ttl time.Duration
}

func NewSessions(rdb *redis.Client, ttl time.Duration) *Sessions {
	return &Sessions{rdb: rdb, ttl: ttl}
}

func (s *Sessions) Create(ctx context.Context, userID uuid.UUID) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate session token: %w", err)
	}
	token := hex.EncodeToString(raw)
	if err := s.rdb.Set(ctx, sessionPrefix+token, userID.String(), s.ttl).Err(); err != nil {
		return "", fmt.Errorf("store session: %w", err)
	}
	return token, nil
}

func (s *Sessions) Get(ctx context.Context, token string) (uuid.UUID, error) {
	val, err := s.rdb.Get(ctx, sessionPrefix+token).Result()
	if errors.Is(err, redis.Nil) {
		return uuid.Nil, ErrNoSession
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("load session: %w", err)
	}
	userID, err := uuid.Parse(val)
	if err != nil {
		return uuid.Nil, fmt.Errorf("parse session user id: %w", err)
	}
	// Sliding TTL: активная сессия продлевается.
	s.rdb.Expire(ctx, sessionPrefix+token, s.ttl)
	return userID, nil
}

func (s *Sessions) Delete(ctx context.Context, token string) error {
	if err := s.rdb.Del(ctx, sessionPrefix+token).Err(); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

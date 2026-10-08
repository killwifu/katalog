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

var ErrNoToken = errors.New("auth: token not found or already used")

// Tokens — одноразовые токены (сброс пароля, подтверждение email) в Redis:
// tok:{purpose}:{token} -> user_id с TTL. Consume атомарно удаляет (GETDEL),
// поэтому токен нельзя использовать дважды.
type Tokens struct {
	rdb *redis.Client
}

func NewTokens(rdb *redis.Client) *Tokens {
	return &Tokens{rdb: rdb}
}

func (t *Tokens) Create(ctx context.Context, purpose string, userID uuid.UUID, ttl time.Duration) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	token := hex.EncodeToString(raw)
	// Токен и его запись в индексе пользователя — одной транзакцией: по
	// индексу RevokeAll находит все невыданные токены (см. ниже).
	idx := indexKey(purpose, userID)
	pipe := t.rdb.TxPipeline()
	pipe.Set(ctx, tokenKey(purpose, token), userID.String(), ttl)
	pipe.SAdd(ctx, idx, token)
	pipe.Expire(ctx, idx, ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		return "", fmt.Errorf("store %s token: %w", purpose, err)
	}
	return token, nil
}

func (t *Tokens) Consume(ctx context.Context, purpose, token string) (uuid.UUID, error) {
	val, err := t.rdb.GetDel(ctx, tokenKey(purpose, token)).Result()
	if errors.Is(err, redis.Nil) {
		return uuid.Nil, ErrNoToken
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("consume %s token: %w", purpose, err)
	}
	userID, err := uuid.Parse(val)
	if err != nil {
		return uuid.Nil, fmt.Errorf("parse %s token user id: %w", purpose, err)
	}
	return userID, nil
}

// RevokeAll отзывает все ещё не использованные токены назначения у
// пользователя. После сброса или смены пароля прочие ссылки «сбросить
// пароль» должны перестать работать: иначе ссылка из письма, попавшего в
// чужие руки, позволяла перехватить аккаунт уже после того, как владелец
// сам сменил пароль.
func (t *Tokens) RevokeAll(ctx context.Context, purpose string, userID uuid.UUID) error {
	idx := indexKey(purpose, userID)
	tokens, err := t.rdb.SMembers(ctx, idx).Result()
	if err != nil {
		return fmt.Errorf("list %s tokens: %w", purpose, err)
	}
	keys := make([]string, 0, len(tokens)+1)
	keys = append(keys, idx)
	for _, tok := range tokens {
		keys = append(keys, tokenKey(purpose, tok))
	}
	if err := t.rdb.Del(ctx, keys...).Err(); err != nil {
		return fmt.Errorf("revoke %s tokens: %w", purpose, err)
	}
	return nil
}

func tokenKey(purpose, token string) string {
	return "tok:" + purpose + ":" + token
}

func indexKey(purpose string, userID uuid.UUID) string {
	return "tokidx:" + purpose + ":" + userID.String()
}

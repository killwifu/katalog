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
	// SignedHintCookie — подсказка «сессия есть» для публичных страниц.
	// Сама сессия httpOnly и из JS не читается, а статическая главная
	// не может знать о ней на сервере: она отдаётся из кеша всем одинаково.
	// Поэтому рядом кладём булев маркер, доступный скрипту.
	//
	// Секретов в нём нет и авторизацией он не является: доступ по-прежнему
	// проверяется по httpOnly-сессии на сервере. Маркер лишь решает,
	// написать в шапке «Кабинет» или «Войти».
	SignedHintCookie = "katalog_signed"
	sessionPrefix    = "sess:"
	// userSessionsPrefix — обратный индекс «пользователь -> его токены».
	// Без него сессию можно только дождаться по TTL: смена пароля не
	// выгоняет того, кто уже вошёл с угнанной cookie.
	userSessionsPrefix = "usess:"
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
	idx := userSessionsPrefix + userID.String()
	pipe := s.rdb.TxPipeline()
	pipe.Set(ctx, sessionPrefix+token, userID.String(), s.ttl)
	pipe.SAdd(ctx, idx, token)
	// Индекс живёт не меньше самой долгой сессии в нём; протухшие токены
	// в наборе безвредны — DEL по несуществующему ключу ничего не делает.
	pipe.Expire(ctx, idx, s.ttl)
	if _, err := pipe.Exec(ctx); err != nil {
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
	// Владельца читаем до удаления, чтобы вычистить и обратный индекс.
	if uid, err := s.rdb.Get(ctx, sessionPrefix+token).Result(); err == nil {
		s.rdb.SRem(ctx, userSessionsPrefix+uid, token)
	}
	if err := s.rdb.Del(ctx, sessionPrefix+token).Err(); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// DeleteAllForUser закрывает все сессии пользователя. Вызывается при смене
// пароля: человек меняет его как раз тогда, когда подозревает чужой доступ,
// и оставлять чужую сессию живой до истечения TTL нельзя.
func (s *Sessions) DeleteAllForUser(ctx context.Context, userID uuid.UUID) error {
	idx := userSessionsPrefix + userID.String()
	tokens, err := s.rdb.SMembers(ctx, idx).Result()
	if err != nil {
		return fmt.Errorf("list user sessions: %w", err)
	}
	keys := make([]string, 0, len(tokens)+1)
	for _, t := range tokens {
		keys = append(keys, sessionPrefix+t)
	}
	keys = append(keys, idx)
	if err := s.rdb.Del(ctx, keys...).Err(); err != nil {
		return fmt.Errorf("delete user sessions: %w", err)
	}
	return nil
}

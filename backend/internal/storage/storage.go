// Package storage — S3-совместимое хранилище (MinIO локально).
// Ключи: orig/{shop_id}/{photo_id}, drv/{shop_id}/{photo_id}/{size}.webp.
package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type Client struct {
	// ops — клиент для операций сервера (внутренний endpoint, minio:9000).
	ops *minio.Client
	// presign — клиент, подписывающий URL с публичным endpoint,
	// доступным из браузера (подпись зависит от host).
	presign    *minio.Client
	bucket     string
	publicBase string
}

func New(endpoint, publicEndpoint, accessKey, secretKey, bucket, region string) (*Client, error) {
	ops, err := newMinio(endpoint, accessKey, secretKey, region)
	if err != nil {
		return nil, fmt.Errorf("create s3 client for %s: %w", endpoint, err)
	}
	pre, err := newMinio(publicEndpoint, accessKey, secretKey, region)
	if err != nil {
		return nil, fmt.Errorf("create s3 presign client for %s: %w", publicEndpoint, err)
	}
	return &Client{
		ops:        ops,
		presign:    pre,
		bucket:     bucket,
		publicBase: strings.TrimRight(publicEndpoint, "/"),
	}, nil
}

// PublicDerivativeURL — прямой URL дериватива на публичном endpoint
// (анонимное чтение разрешено только для префикса drv/).
func (c *Client) PublicDerivativeURL(shopID, photoID uuid.UUID, size int) string {
	return fmt.Sprintf("%s/%s/%s", c.publicBase, c.bucket, DerivativeKey(shopID, photoID, size))
}

func newMinio(endpoint, accessKey, secretKey, region string) (*minio.Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("parse endpoint: %w", err)
	}
	return minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: u.Scheme == "https",
		// Явный регион: без него minio-go делает сетевой GetBucketLocation,
		// а presign-клиент указывает на публичный endpoint, недоступный
		// из контейнера api.
		Region: region,
	})
}

func OrigKey(shopID, photoID uuid.UUID) string {
	return fmt.Sprintf("orig/%s/%s", shopID, photoID)
}

func DerivativeKey(shopID, photoID uuid.UUID, size int) string {
	return fmt.Sprintf("drv/%s/%s/%d.webp", shopID, photoID, size)
}

// PresignPut возвращает URL для прямой загрузки оригинала из браузера.
func (c *Client) PresignPut(ctx context.Context, key string, expiry time.Duration) (string, error) {
	u, err := c.presign.PresignedPutObject(ctx, c.bucket, key, expiry)
	if err != nil {
		return "", fmt.Errorf("presign put %s: %w", key, err)
	}
	return u.String(), nil
}

// StatSize возвращает размер объекта; ok=false, если объект не существует.
func (c *Client) StatSize(ctx context.Context, key string) (int64, bool, error) {
	info, err := c.ops.StatObject(ctx, c.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		resp := minio.ToErrorResponse(err)
		if resp.Code == "NoSuchKey" || resp.StatusCode == 404 {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("stat %s: %w", key, err)
	}
	return info.Size, true, nil
}

// Delete удаляет объект. Отсутствие объекта ошибкой не считается: вызывающий
// код убирает мусор, а не проверяет наличие.
func (c *Client) Delete(ctx context.Context, key string) error {
	if err := c.ops.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		resp := minio.ToErrorResponse(err)
		if resp.Code == "NoSuchKey" || resp.StatusCode == 404 {
			return nil
		}
		return fmt.Errorf("delete %s: %w", key, err)
	}
	return nil
}

func (c *Client) Download(ctx context.Context, key string) ([]byte, error) {
	obj, err := c.ops.GetObject(ctx, c.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", key, err)
	}
	defer func() { _ = obj.Close() }()
	data, err := io.ReadAll(obj)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", key, err)
	}
	return data, nil
}

func (c *Client) Upload(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := c.ops.PutObject(ctx, c.bucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: contentType})
	if err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	return nil
}

// RemoveShop удаляет все объекты магазина — оригиналы и деривативы.
// Используется при удалении магазина, когда перечислить фото уже негде:
// строки снёс каскад по внешнему ключу.
func (c *Client) RemoveShop(ctx context.Context, shopID uuid.UUID) error {
	for _, prefix := range []string{
		fmt.Sprintf("orig/%s/", shopID),
		fmt.Sprintf("drv/%s/", shopID),
	} {
		objects := c.ops.ListObjects(ctx, c.bucket, minio.ListObjectsOptions{
			Prefix: prefix, Recursive: true,
		})
		// Канал ошибок дочитываем до конца даже после первой: бросить его
		// значит подвесить горутину minio-go, которая в него пишет.
		var firstErr error
		for err := range c.ops.RemoveObjects(ctx, c.bucket, objects, minio.RemoveObjectsOptions{}) {
			if firstErr == nil {
				firstErr = fmt.Errorf("remove %s: %w", err.ObjectName, err.Err)
			}
		}
		if firstErr != nil {
			return firstErr
		}
	}
	return nil
}

// RemoveDerivatives удаляет только деривативы (drv/), оригинал остаётся
// как доказательство и для разблокировки.
//
// ВНИМАНИЕ: удаление объекта останавливает только источник. Деривативы
// отдаются с CDN-домена с Cache-Control: max-age=31536000, immutable —
// значит, край CDN продолжит отдавать уже закешированную копию по тому же
// адресу, пока не истечёт TTL. Сброс кеша CDN здесь не вызывается: он
// зависит от провайдера и в проекте не настроен. Для снятия по жалобе
// правообладателя этого недостаточно — см. handleAdminBlockPhoto.
func (c *Client) RemoveDerivatives(ctx context.Context, shopID, photoID uuid.UUID, sizes []int) error {
	var errs []string
	for _, s := range sizes {
		key := DerivativeKey(shopID, photoID, s)
		if err := c.ops.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{}); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", key, err))
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("remove derivatives: %s", strings.Join(errs, "; "))
	}
	return nil
}

// RemovePhoto удаляет оригинал и все деривативы фото.
func (c *Client) RemovePhoto(ctx context.Context, shopID, photoID uuid.UUID, sizes []int) error {
	keys := []string{OrigKey(shopID, photoID)}
	for _, s := range sizes {
		keys = append(keys, DerivativeKey(shopID, photoID, s))
	}
	var errs []string
	for _, key := range keys {
		if err := c.ops.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{}); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", key, err))
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("remove photo objects: %s", strings.Join(errs, "; "))
	}
	return nil
}

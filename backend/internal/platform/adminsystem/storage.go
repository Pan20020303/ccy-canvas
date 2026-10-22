package adminsystem

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"ccy-canvas/backend/internal/platform/assetstore"
	crypt "ccy-canvas/backend/internal/platform/crypto"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrConflict = errors.New("配置已被其他管理员更新，请重新加载后再修改")

type storageDocument struct {
	Config  assetstore.Config        `json:"config"`
	Readers []assetstore.ReadProfile `json:"readers"`
}
type storageRecord struct {
	Revision  int64
	Encrypted string
	UpdatedAt time.Time
}
type storageRepository interface {
	Read(context.Context) (storageRecord, error)
	Write(context.Context, int64, string) (storageRecord, error)
}
type postgresStorage struct{ pool *pgxpool.Pool }

func (r postgresStorage) Read(ctx context.Context) (storageRecord, error) {
	var row storageRecord
	err := r.pool.QueryRow(ctx, `SELECT revision, encrypted_config, updated_at FROM media_storage_settings WHERE id=true`).Scan(&row.Revision, &row.Encrypted, &row.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return row, nil
	}
	return row, err
}
func (r postgresStorage) Write(ctx context.Context, expected int64, encrypted string) (storageRecord, error) {
	var row storageRecord
	// One conditional statement provides cross-process compare-and-swap, including initial creation.
	err := r.pool.QueryRow(ctx, `INSERT INTO media_storage_settings(id,revision,encrypted_config)
	 SELECT true,1,$2 WHERE $1::bigint=0 OR EXISTS(SELECT 1 FROM media_storage_settings WHERE id=true)
	 ON CONFLICT(id) DO UPDATE SET revision=media_storage_settings.revision+1, encrypted_config=EXCLUDED.encrypted_config,updated_at=now()
	 WHERE media_storage_settings.revision=$1
	 RETURNING revision,encrypted_config,updated_at`, expected, encrypted).Scan(&row.Revision, &row.Encrypted, &row.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return row, ErrConflict
	}
	return row, err
}

type StorageManager struct {
	mu      sync.Mutex
	repo    storageRepository
	key     []byte
	applied int64
}

func NewStorageManager(pool *pgxpool.Pool, key []byte) *StorageManager {
	return &StorageManager{repo: postgresStorage{pool}, key: key}
}
func (m *StorageManager) read(ctx context.Context) (storageDocument, storageRecord, error) {
	r, err := m.repo.Read(ctx)
	if err != nil {
		return storageDocument{}, r, fmt.Errorf("无法读取存储配置，请检查数据库与 047 迁移")
	}
	if r.Revision == 0 {
		return storageDocument{Config: assetstore.EnvironmentConfig()}, r, nil
	}
	plain, err := crypt.Decrypt(m.key, r.Encrypted)
	if err != nil {
		return storageDocument{}, r, fmt.Errorf("存储配置解密失败，请检查服务器加密密钥")
	}
	var doc storageDocument
	if json.Unmarshal([]byte(plain), &doc) != nil {
		return doc, r, fmt.Errorf("存储配置格式损坏")
	}
	return doc, r, nil
}

type CloudView struct {
	Bucket             string `json:"bucket"`
	Region             string `json:"region"`
	Endpoint           string `json:"endpoint"`
	PublicBaseURL      string `json:"public_base_url"`
	KeyPrefix          string `json:"key_prefix"`
	HasAccessKeyID     bool   `json:"has_access_key_id"`
	HasAccessKeySecret bool   `json:"has_access_key_secret"`
}
type StorageView struct {
	Backend        string     `json:"backend"`
	OSS            CloudView  `json:"oss"`
	COS            CloudView  `json:"cos"`
	Revision       int64      `json:"revision"`
	Source         string     `json:"source"`
	UpdatedAt      *time.Time `json:"updated_at"`
	LocalDirectory string     `json:"local_directory"`
	Configured     bool       `json:"configured"`
}

func storageView(doc storageDocument, r storageRecord) StorageView {
	cloud := func(c assetstore.CloudConfig) CloudView {
		return CloudView{c.Bucket, c.Region, c.Endpoint, c.PublicBaseURL, c.KeyPrefix, c.AccessKeyID != "", c.AccessKeySecret != ""}
	}
	_, err := assetstore.Build(doc.Config)
	v := StorageView{Backend: doc.Config.Backend, OSS: cloud(doc.Config.OSS), COS: cloud(doc.Config.COS), Revision: r.Revision, Source: "environment", LocalDirectory: assetstore.LocalRoot(), Configured: err == nil}
	if r.Revision > 0 {
		v.Source = "database"
		v.UpdatedAt = &r.UpdatedAt
	}
	return v
}
func (m *StorageManager) View(ctx context.Context) (StorageView, error) {
	doc, r, err := m.read(ctx)
	if err != nil {
		return StorageView{}, err
	}
	return storageView(doc, r), nil
}

type CloudInput struct {
	Bucket          string `json:"bucket" maxLength:"63"`
	Region          string `json:"region" maxLength:"63"`
	Endpoint        string `json:"endpoint" maxLength:"512"`
	PublicBaseURL   string `json:"public_base_url" maxLength:"512"`
	KeyPrefix       string `json:"key_prefix" maxLength:"256"`
	AccessKeyID     string `json:"access_key_id" maxLength:"256"`
	AccessKeySecret string `json:"access_key_secret" maxLength:"512"`
}
type StorageInput struct {
	Revision int64       `json:"revision" minimum:"0"`
	Backend  string      `json:"backend" enum:"local,oss,cos"`
	Cloud    *CloudInput `json:"cloud,omitempty"`
}

func mergeCloud(old assetstore.CloudConfig, in CloudInput) assetstore.CloudConfig {
	c := assetstore.CloudConfig{Bucket: strings.TrimSpace(in.Bucket), Region: strings.TrimSpace(in.Region), Endpoint: strings.TrimRight(strings.TrimSpace(in.Endpoint), "/"), PublicBaseURL: strings.TrimRight(strings.TrimSpace(in.PublicBaseURL), "/"), KeyPrefix: strings.TrimSpace(in.KeyPrefix), AccessKeyID: strings.TrimSpace(in.AccessKeyID), AccessKeySecret: strings.TrimSpace(in.AccessKeySecret)}
	if c.AccessKeyID == "" {
		c.AccessKeyID = old.AccessKeyID
	}
	if c.AccessKeySecret == "" {
		c.AccessKeySecret = old.AccessKeySecret
	}
	return c
}
func retainReaders(doc *storageDocument, old assetstore.Config) {
	profiles := []assetstore.ReadProfile{{Backend: "oss", Cloud: old.OSS}, {Backend: "cos", Cloud: old.COS}}
	profiles = append(profiles, doc.Readers...)
	seen := map[string]bool{}
	doc.Readers = nil
	for _, p := range profiles {
		if _, err := assetstore.BuildReader(p); err != nil {
			continue
		}
		// A rotated key supersedes old keys for the same location. Other buckets remain readable.
		id := p.Backend + "|" + p.Cloud.Bucket + "|" + p.Cloud.Region + "|" + p.Cloud.Endpoint + "|" + p.Cloud.PublicBaseURL
		if !seen[id] {
			doc.Readers = append(doc.Readers, p)
			seen[id] = true
		}
	}
}
func activate(doc storageDocument) error {
	active, err := assetstore.Build(doc.Config)
	if err != nil {
		return err
	}
	readers := []assetstore.Store{}
	for _, p := range append([]assetstore.ReadProfile{{Backend: "oss", Cloud: doc.Config.OSS}, {Backend: "cos", Cloud: doc.Config.COS}}, doc.Readers...) {
		if s, err := assetstore.BuildReader(p); err == nil {
			readers = append(readers, s)
		}
	}
	assetstore.Activate(active, readers)
	return nil
}
func (m *StorageManager) Save(ctx context.Context, in StorageInput) (StorageView, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	doc, row, err := m.read(ctx)
	if err != nil {
		return StorageView{}, err
	}
	if row.Revision != in.Revision {
		return StorageView{}, ErrConflict
	}
	old := doc.Config
	doc.Config.Backend = in.Backend
	if in.Backend != "local" {
		if in.Cloud == nil {
			return StorageView{}, fmt.Errorf("请填写所选存储配置")
		}
		if in.Backend == "oss" {
			doc.Config.OSS = mergeCloud(old.OSS, *in.Cloud)
		} else if in.Backend == "cos" {
			doc.Config.COS = mergeCloud(old.COS, *in.Cloud)
		}
	}
	if _, err = assetstore.Build(doc.Config); err != nil {
		return StorageView{}, err
	}
	retainReaders(&doc, old)
	plain, err := json.Marshal(doc)
	if err != nil {
		return StorageView{}, fmt.Errorf("无法编码存储配置")
	}
	encrypted, err := crypt.Encrypt(m.key, string(plain))
	if err != nil {
		return StorageView{}, fmt.Errorf("服务器尚未配置有效加密密钥")
	}
	row, err = m.repo.Write(ctx, in.Revision, encrypted)
	if errors.Is(err, ErrConflict) {
		return StorageView{}, err
	}
	if err != nil {
		return StorageView{}, fmt.Errorf("存储配置保存失败，原配置未切换")
	}
	_ = activate(doc) // Same immutable config was validated before committing.
	m.applied = row.Revision
	return storageView(doc, row), nil
}
func (m *StorageManager) Sync(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	doc, row, err := m.read(ctx)
	if err != nil {
		return err
	}
	if row.Revision == 0 || row.Revision == m.applied {
		return nil
	}
	if err = activate(doc); err != nil {
		return fmt.Errorf("数据库存储配置不可用")
	}
	m.applied = row.Revision
	return nil
}

// Polling makes the DB configuration effective on every API/worker replica.
func (m *StorageManager) Watch(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			attempt, cancel := context.WithTimeout(ctx, 4*time.Second)
			_ = m.Sync(attempt) // Keep last working clients during a transient DB outage.
			cancel()
		}
	}
}

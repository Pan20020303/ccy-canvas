package assetstore

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// Config is internal. Never serialize it into an API response.
type CloudConfig struct {
	Bucket          string `json:"bucket"`
	Region          string `json:"region"`
	Endpoint        string `json:"endpoint"`
	PublicBaseURL   string `json:"public_base_url"`
	KeyPrefix       string `json:"key_prefix"`
	AccessKeyID     string `json:"access_key_id"`
	AccessKeySecret string `json:"access_key_secret"`
}
type Config struct {
	Backend string      `json:"backend"`
	OSS     CloudConfig `json:"oss"`
	COS     CloudConfig `json:"cos"`
}
type ReadProfile struct {
	Backend string      `json:"backend"`
	Cloud   CloudConfig `json:"cloud"`
}

func LocalRoot() string { return envOrDefault("UPLOAD_DIR", "uploads") }

func EnvironmentConfig() Config {
	cloud := func(prefix, id, secret string) CloudConfig {
		get := func(key string) string { return strings.TrimSpace(os.Getenv(prefix + key)) }
		return CloudConfig{Bucket: get("BUCKET"), Region: get("REGION"), Endpoint: get("ENDPOINT"), PublicBaseURL: get("PUBLIC_BASE_URL"), KeyPrefix: get("KEY_PREFIX"), AccessKeyID: get(id), AccessKeySecret: get(secret)}
	}
	return Config{Backend: strings.ToLower(envOrDefault("STORAGE_BACKEND", "local")), OSS: cloud("OSS_", "ACCESS_KEY_ID", "ACCESS_KEY_SECRET"), COS: cloud("COS_", "SECRET_ID", "SECRET_KEY")}
}

var safeName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)

// Format validation only; never claim that remote credentials were tested.
func ValidateCloud(backend string, c CloudConfig) error {
	if !safeName.MatchString(c.Bucket) || !safeName.MatchString(c.Region) {
		return fmt.Errorf("Bucket 与地域须使用小写字母、数字或连字符")
	}
	if c.AccessKeyID == "" || c.AccessKeySecret == "" {
		return fmt.Errorf("请填写 AccessKey ID 和 Secret")
	}
	for _, raw := range []string{c.Endpoint, c.PublicBaseURL} {
		if raw == "" {
			continue
		}
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("Endpoint 与访问地址必须为不含账号、查询参数的 HTTPS 地址")
		}
	}
	if c.Endpoint != "" {
		u, _ := url.Parse(c.Endpoint)
		suffix := ".aliyuncs.com"
		if backend == "cos" {
			suffix = ".myqcloud.com"
		}
		if !strings.HasSuffix(u.Hostname(), suffix) || u.Port() != "" || (u.Path != "" && u.Path != "/") {
			return fmt.Errorf("Endpoint 须为对应云厂商的标准 HTTPS 域名；自定义域名请填写访问地址")
		}
	}
	if strings.Contains(c.KeyPrefix, "\\") || strings.Contains(c.KeyPrefix, "..") || strings.HasPrefix(c.KeyPrefix, "/") {
		return fmt.Errorf("目录前缀不能包含反斜杠、.. 或以 / 开头")
	}
	return nil
}

func Build(c Config) (Store, error) {
	switch c.Backend {
	case "local":
		return localStore{root: LocalRoot()}, nil
	case "oss":
		if err := ValidateCloud("oss", c.OSS); err != nil {
			return nil, err
		}
		return newOSSStoreConfig(c.OSS)
	case "cos":
		if err := ValidateCloud("cos", c.COS); err != nil {
			return nil, err
		}
		return newCOSStoreConfig(c.COS)
	default:
		return nil, fmt.Errorf("不支持的存储方式")
	}
}

// In-flight uploads retain their immutable client during a switch.
func Activate(active Store, readers []Store) {
	runtimeMu.Lock()
	runtimeStore = active
	runtimeReaders = append([]Store{active}, readers...)
	runtimeMu.Unlock()
}

func BuildReader(p ReadProfile) (Store, error) {
	if p.Backend == "oss" {
		return newOSSStoreConfig(p.Cloud)
	}
	if p.Backend == "cos" {
		return newCOSStoreConfig(p.Cloud)
	}
	return nil, fmt.Errorf("unknown reader")
}

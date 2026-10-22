package assetstore

import "testing"

func TestCloudConfigValidation(t *testing.T) {
	base := CloudConfig{Bucket: "media-bucket", Region: "cn-beijing", AccessKeyID: "id", AccessKeySecret: "secret"}
	if err := ValidateCloud("oss", base); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{"http://oss-cn-beijing.aliyuncs.com", "https://127.0.0.1", "https://aliyuncs.com.evil.test", "https://user:pass@oss-cn-beijing.aliyuncs.com", "https://oss-cn-beijing.aliyuncs.com?secret=value", "https://oss-cn-beijing.aliyuncs.com:9000"} {
		c := base
		c.Endpoint = endpoint
		if ValidateCloud("oss", c) == nil {
			t.Fatalf("accepted %s", endpoint)
		}
	}
	c := base
	c.Endpoint = "https://oss-cn-beijing.aliyuncs.com"
	if ValidateCloud("oss", c) != nil {
		t.Fatal("standard OSS endpoint rejected")
	}
	for _, prefix := range []string{"../outside", "/absolute", "a\\b"} {
		c := base
		c.KeyPrefix = prefix
		if ValidateCloud("oss", c) == nil {
			t.Fatal("unsafe prefix accepted")
		}
	}
}

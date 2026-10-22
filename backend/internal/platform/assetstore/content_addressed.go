package assetstore

import (
	"context"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"os"
	"time"
)

// UploadContentAddressedFile is only for immutable, content-hashed keys. Reuse
// an existing OSS object instead of retransmitting the same reference on every
// model call. Never use this for mutable keys. Lookup failure falls back to the
// usual upload; it must not introduce a new hard dependency on HEAD permissions.
func UploadContentAddressedFile(ctx context.Context, key, localPath, contentType string) (string, error) {
	store, err := Default()
	if err != nil {
		return "", err
	}
	if s, ok := store.(ossStore); ok {
		info, statErr := os.Stat(localPath)
		objKey, keyErr := s.objectKey(key)
		if statErr == nil && keyErr == nil && info.Size() > 0 {
			lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			head, headErr := s.client.HeadObject(lookupCtx, &oss.HeadObjectRequest{Bucket: oss.Ptr(s.bucket), Key: oss.Ptr(objKey)})
			cancel()
			if headErr == nil && head.ContentLength == info.Size() {
				return s.publicBase + "/" + objKey, nil
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return store.UploadFile(ctx, key, localPath, contentType)
}

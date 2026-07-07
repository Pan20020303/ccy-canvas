// Command osscopy is a one-off migration helper for COS → OSS. It reads COS
// object URLs from stdin (one per line), downloads each from the public COS
// bucket, and uploads it to OSS at the IDENTICAL key, so the later host-only
// URL rewrite (backend/db/manual/oss-url-rewrite.sql) resolves to real objects.
//
// It talks to OSS directly (NOT via assetstore) so it writes the exact key
// without OSS_KEY_PREFIX being applied a second time. COS objects must be
// publicly readable to be copied this way — private objects (403) must first be
// made public-read on COS, or handled via a presigned fetch.
//
// Usage (loads OSS_* from .env into the env, feeds the extracted URL list):
//
//	go run ./cmd/osscopy < cos_urls.txt
//
// See backend/db/manual/oss-migration.md for the full procedure.
package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
)

const cosBase = "https://ccy-canvas-1334659054.cos.ap-beijing.myqcloud.com/"

func main() {
	bucket := os.Getenv("OSS_BUCKET")
	region := os.Getenv("OSS_REGION")
	id := os.Getenv("OSS_ACCESS_KEY_ID")
	secret := os.Getenv("OSS_ACCESS_KEY_SECRET")
	if bucket == "" || region == "" || id == "" || secret == "" {
		fmt.Fprintln(os.Stderr, "missing OSS_* env")
		os.Exit(2)
	}
	client := oss.NewClient(oss.LoadDefaultConfig().
		WithCredentialsProvider(credentials.NewStaticCredentialsProvider(id, secret)).
		WithRegion(region))
	httpc := &http.Client{Timeout: 5 * time.Minute}
	ctx := context.Background()

	var ok, fail int
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		u := strings.TrimSpace(sc.Text())
		if u == "" || !strings.HasPrefix(u, cosBase) {
			continue
		}
		key := u[len(cosBase):]
		if i := strings.IndexAny(key, "?#"); i >= 0 {
			key = key[:i]
		}
		if key == "" {
			continue
		}

		resp, err := httpc.Get(u)
		if err != nil {
			fmt.Printf("GET_ERR  %s: %v\n", key, err)
			fail++
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			fmt.Printf("GET_%d   %s\n", resp.StatusCode, key)
			fail++
			continue
		}
		ct := resp.Header.Get("Content-Type")

		_, err = client.PutObject(ctx, &oss.PutObjectRequest{
			Bucket:       oss.Ptr(bucket),
			Key:          oss.Ptr(key),
			Body:         bytes.NewReader(body),
			Acl:          oss.ObjectACLPublicRead,
			ContentType:  ptrOrNil(ct),
			CacheControl: oss.Ptr("public, max-age=31536000"),
		})
		if err != nil {
			fmt.Printf("PUT_ERR  %s: %v\n", key, err)
			fail++
			continue
		}
		ok++
		fmt.Printf("OK       %s (%d bytes, %s)\n", key, len(body), ct)
	}
	if err := sc.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "scan:", err)
	}
	fmt.Printf("== done: ok=%d fail=%d ==\n", ok, fail)
	if fail > 0 {
		os.Exit(1)
	}
}

func ptrOrNil(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return oss.Ptr(s)
}

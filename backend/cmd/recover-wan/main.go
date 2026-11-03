// Lookup/recover existing HopBase Wan tasks. Never submits generation or charges credits.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ccy-canvas/backend/internal/platform/adminsystem"
	"ccy-canvas/backend/internal/platform/assetstore"
	"ccy-canvas/backend/internal/platform/config"
	"ccy-canvas/backend/internal/platform/crypto"
	"ccy-canvas/backend/internal/platform/database"
	"ccy-canvas/backend/internal/shared/safehttp"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: recover-wan <generation-log-id> [...]")
	}
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	pool, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("database unavailable")
	}
	defer pool.Close()
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSHandshakeTimeout = 30 * time.Second
	client := &http.Client{Transport: tr, Timeout: 45 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	ids := os.Args[1:]
	restore := ids[0] == "--restore"
	if restore {
		ids = ids[1:]
		if len(ids) == 0 {
			return fmt.Errorf("explicit log IDs required")
		}
		if err := adminsystem.NewStorageManager(pool, cfg.EncryptionKey).Sync(ctx); err != nil {
			return fmt.Errorf("media storage unavailable")
		}
	}
	for _, id := range ids {
		var taskID, baseURL, encryptedKey string
		err := pool.QueryRow(ctx, `SELECT g.request_payload->'_upstream_task'->>'task_id', p.base_url, p.encrypted_api_key
   FROM generation_logs g JOIN provider_configs p ON p.id::text=g.request_payload->'_upstream_task'->>'provider_config_id'
   WHERE g.id=$1 AND g.model='wan3.0-video'`, id).Scan(&taskID, &baseURL, &encryptedKey)
		if err != nil {
			return fmt.Errorf("task %s: checkpoint unavailable", id)
		}
		base, err := url.Parse(baseURL)
		if err != nil || base.Scheme != "https" || base.Host != "api.hop-base.com" {
			return fmt.Errorf("task %s: unexpected provider host", id)
		}
		key, err := crypto.Decrypt(cfg.EncryptionKey, encryptedKey)
		if err != nil {
			return fmt.Errorf("provider credentials unavailable")
		}
		endpoint := "https://" + base.Host + "/api/v1/tasks/" + url.PathEscape(taskID)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		req.Header.Set("Authorization", "Bearer "+key)
		var resp *http.Response
		for attempt := 0; attempt < 3; attempt++ {
			resp, err = client.Do(req.Clone(ctx))
			if err == nil {
				break
			}
			if ctx.Err() != nil {
				break
			}
		}
		if err != nil {
			return fmt.Errorf("task %s: lookup connection failed after 3 GET attempts", id)
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("task %s: response incomplete", id)
		}
		// Print only the status/result, not headers, credentials or original prompts.
		var result struct {
			Output struct {
				Status   string `json:"task_status"`
				VideoURL string `json:"video_url"`
				Code     string `json:"code"`
				Message  string `json:"message"`
			} `json:"output"`
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(body, &result); err != nil {
			return fmt.Errorf("task %s: invalid query response (HTTP %d)", id, resp.StatusCode)
		}
		if restore {
			if result.Output.Status != "SUCCEEDED" || result.Output.VideoURL == "" {
				return fmt.Errorf("task %s is not completed; no changes made", id)
			}
			stable, err := restoreResult(ctx, pool, id, taskID, result.Output.VideoURL)
			if err != nil {
				return err
			}
			result.Output.VideoURL = stable
		}
		safe, _ := json.Marshal(map[string]any{"log_id": id, "task_id": taskID, "http_status": resp.StatusCode, "restored": restore, "result": result})
		fmt.Println(strings.ReplaceAll(string(safe), key, "[redacted]"))
	}
	return nil
}

func restoreResult(ctx context.Context, pool *pgxpool.Pool, id, taskID, mediaURL string) (string, error) {
	var original []byte
	var status, existing string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(g),status,COALESCE(result_url,'') FROM generation_logs g WHERE id=$1`, id).Scan(&original, &status, &existing); err != nil {
		return "", fmt.Errorf("task record unavailable")
	}
	if status == "success" && existing != "" {
		return existing, nil
	}
	if status != "error" || existing != "" {
		return "", fmt.Errorf("task %s changed; refusing to overwrite", id)
	}
	folder := filepath.Join("run", "recovered-videos")
	if err := os.MkdirAll(folder, 0700); err != nil {
		return "", err
	}
	backup, err := os.OpenFile(filepath.Join(folder, id+".before.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil && !os.IsExist(err) {
		return "", err
	}
	if err == nil {
		_, err = backup.Write(original)
		backup.Close()
		if err != nil {
			return "", err
		}
	}
	if err := safehttp.ValidatePublicURL(mediaURL); err != nil {
		return "", fmt.Errorf("invalid media URL")
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, mediaURL, nil)
	response, err := safehttp.Client(3 * time.Minute).Do(req)
	if err != nil {
		return "", fmt.Errorf("task %s: media download failed", id)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", fmt.Errorf("task %s: media HTTP %d", id, response.StatusCode)
	}
	head := make([]byte, 512)
	n, err := io.ReadFull(response.Body, head)
	if err != nil || n < 12 || string(head[4:8]) != "ftyp" {
		return "", fmt.Errorf("task %s: result is not an MP4", id)
	}
	file, err := os.CreateTemp(folder, id+"-*.mp4")
	if err != nil {
		return "", err
	}
	if _, err = file.Write(head); err != nil {
		file.Close()
		return "", err
	}
	const maxBytes = 512 << 20
	size, err := io.Copy(file, io.LimitReader(response.Body, maxBytes))
	closeErr := file.Close()
	if err != nil || closeErr != nil || size >= maxBytes {
		return "", fmt.Errorf("task %s: incomplete media", id)
	}
	objectKey := "generated/" + time.Now().Format("2006-01") + "/recovered-" + id + ".mp4"
	stable, err := assetstore.UploadFile(ctx, objectKey, file.Name(), "video/mp4")
	if err != nil {
		return "", fmt.Errorf("task %s: media storage failed; local backup retained", id)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Exec(ctx, `UPDATE generation_logs SET status='success',result_url=$2,error_msg='',asset_status='ready',asset_error='',cos_key=$3,cos_url=$2,
 request_payload=request_payload||jsonb_build_object('_manual_recovery',jsonb_build_object('at',now(),'previous_error',error_msg,'source','existing_upstream_task'))
 WHERE id=$1 AND status='error' AND COALESCE(result_url,'')='' AND request_payload->'_upstream_task'->>'task_id'=$4`, id, stable, objectKey, taskID)
	if err != nil {
		return "", err
	}
	if rows.RowsAffected() != 1 {
		return "", fmt.Errorf("task changed; rollback, media retained")
	}
	_, err = tx.Exec(ctx, `INSERT INTO generation_history(user_id,client_id,space_id,space_type,project_id,item_type,media_type,title,thumbnail,aspect_ratio,prompt_excerpt,source_node_id,client_ts)
 SELECT user_id,'gen-task-'||id::text,'space-personal','personal',request_payload->>'project_id','video','video',
 '找回视频 · '||to_char(created_at AT TIME ZONE 'Asia/Shanghai','HH24:MI'),$2,request_payload->>'AspectRatio',left(prompt,120),node_id,(extract(epoch from created_at)*1000)::bigint
 FROM generation_logs WHERE id=$1 ON CONFLICT(user_id,client_id) DO NOTHING`, id, stable)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	fmt.Printf("recovered %s: %d bytes; backup %s\n", id, size+int64(n), file.Name())
	return stable, nil
}

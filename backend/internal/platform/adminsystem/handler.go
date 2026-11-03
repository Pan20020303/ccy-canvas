package adminsystem

import (
	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/httpapi"
	"context"
	"errors"
	"github.com/danielgtaylor/huma/v2"
	"net/http"
)

type Handler struct {
	storage *StorageManager
	metrics *Metrics
}

func NewHandler(storage *StorageManager) *Handler {
	return &Handler{storage: storage, metrics: NewMetrics()}
}

type storageOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         struct {
		Data StorageView `json:"data"`
	}
}
type metricsOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         struct {
		Data ResourceSnapshot `json:"data"`
	}
}
type saveStorageInput struct{ Body StorageInput }

func (h *Handler) RegisterRoutes(api huma.API) {
	security := []map[string][]string{{httpapi.SecuritySchemeName: {authn.ScopeAdmin}}}
	huma.Register(api, huma.Operation{OperationID: "admin-storage-read", Method: http.MethodGet, Path: "/api/admin/storage", Security: security, Tags: []string{"Admin"}}, h.readStorage)
	huma.Register(api, huma.Operation{OperationID: "admin-storage-save", Method: http.MethodPut, Path: "/api/admin/storage", Security: security, Tags: []string{"Admin"}}, h.saveStorage)
	huma.Register(api, huma.Operation{OperationID: "admin-system-resources", Method: http.MethodGet, Path: "/api/admin/system/resources", Security: security, Tags: []string{"Admin"}}, h.resources)
}
func (h *Handler) readStorage(ctx context.Context, _ *struct{}) (*storageOutput, error) {
	v, err := h.storage.View(ctx)
	if err != nil {
		return nil, huma.Error503ServiceUnavailable(err.Error())
	}
	out := &storageOutput{CacheControl: "no-store"}
	out.Body.Data = v
	return out, nil
}
func (h *Handler) saveStorage(ctx context.Context, in *saveStorageInput) (*storageOutput, error) {
	v, err := h.storage.Save(ctx, in.Body)
	if errors.Is(err, ErrConflict) {
		return nil, huma.Error409Conflict(err.Error())
	}
	if err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	out := &storageOutput{CacheControl: "no-store"}
	out.Body.Data = v
	return out, nil
}
func (h *Handler) resources(ctx context.Context, _ *struct{}) (*metricsOutput, error) {
	out := &metricsOutput{CacheControl: "no-store"}
	out.Body.Data = h.metrics.Snapshot(ctx)
	return out, nil
}

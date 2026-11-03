package client

// These structs mirror the backend's JSON contracts 1:1 (json tags identical
// to the server structs). They are intentionally decoupled from the backend's
// huma/sqlc types so the CLI compiles without importing the service/DB layer.

// User mirrors data.user from login/register/me.
type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}

// CreditSummary is only present on GET /api/auth/me.
type CreditSummary struct {
	DailyQuota     int `json:"daily_quota"`
	CurrentBalance int `json:"current_balance"`
	ConsumedToday  int `json:"consumed_today"`
}

// MeData is the data block of GET /api/auth/me.
type MeData struct {
	User          User           `json:"user"`
	CreditSummary *CreditSummary `json:"credit_summary,omitempty"`
}

// authData is the data block of login/register (user only, no credit summary).
type authData struct {
	User User `json:"user"`
}

// Project mirrors the workspace ProjectItem.
type Project struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	CoverURL        string `json:"cover_url"`
	FolderID        string `json:"folder_id"`
	IsCollaborative bool   `json:"is_collaborative"`
	MyRole          string `json:"my_role"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
}

// UserModel mirrors the relay-provider model catalog item (GET /api/app/models).
// NOTE: its ID is NOT a provider_config_id — use ProviderConfig for generation.
type UserModel struct {
	ID                string `json:"id"`
	ExternalModelName string `json:"external_model_name"`
	DisplayName       string `json:"display_name"`
	Capability        string `json:"capability"`
}

// ProviderConfig mirrors AppProviderConfigItem (GET /api/app/provider-configs).
// ID is the provider_config_id to pass to generate.
type ProviderConfig struct {
	ID           string   `json:"id"`
	ServiceType  string   `json:"service_type"`
	Vendor       string   `json:"vendor"`
	Name         string   `json:"name"`
	ModelList    []string `json:"model_list"`
	DefaultModel string   `json:"default_model"`
	Priority     int      `json:"priority"`
}

// GenerateRequest mirrors generateInput.Body exactly. Optional scalars use
// pointers + omitempty so a zero value is never sent where the backend would
// misread it (e.g. seed=0 is a valid seed).
type GenerateRequest struct {
	NodeID           string         `json:"node_id"` // required by the huma schema; auto-filled with a uuid
	ProjectID        string         `json:"project_id,omitempty"`
	RequestID        string         `json:"request_id,omitempty"`
	ProviderConfigID string         `json:"provider_config_id,omitempty"`
	ServiceType      string         `json:"service_type"`
	Model            string         `json:"model"`
	Prompt           string         `json:"prompt"`
	Size             string         `json:"size,omitempty"`
	Resolution       string         `json:"resolution,omitempty"`
	Quality          string         `json:"quality,omitempty"`
	Duration         int            `json:"duration,omitempty"`
	AspectRatio      string         `json:"aspect_ratio,omitempty"`
	ReferenceImages  []string       `json:"reference_images,omitempty"`
	ReferenceVideo   string         `json:"reference_video,omitempty"`
	ReferenceVideos  []string       `json:"reference_videos,omitempty"`
	OutputCount      int            `json:"output_count,omitempty"`
	OutputFormat     string         `json:"output_format,omitempty"`
	ReferenceMode    string         `json:"reference_mode,omitempty"`
	AudioSetting     string         `json:"audio_setting,omitempty"`
	Seed             *int           `json:"seed,omitempty"`
	EnableSequential *bool          `json:"enable_sequential,omitempty"`
	ThinkingMode     *bool          `json:"thinking_mode,omitempty"`
	Parameters       map[string]any `json:"parameters,omitempty"`
}

// GenerateResult mirrors application.GenerateResult (+ task_id).
type GenerateResult struct {
	Type        string   `json:"type"` // "text" | "url" | "queued"
	Content     string   `json:"content"`
	ContentList []string `json:"content_list,omitempty"`
	TaskID      string   `json:"task_id,omitempty"`
}

// TaskItem mirrors the REST task read-projection. NOTE: no result_urls here —
// only result_url (first asset). Full multi-asset arrays come via SSE only.
type TaskItem struct {
	ID          string `json:"id"`
	NodeID      string `json:"node_id"`
	ServiceType string `json:"service_type"`
	Model       string `json:"model"`
	Status      string `json:"status"`
	ResultURL   string `json:"result_url"`
	ErrorMsg    string `json:"error_msg"`
	DurationMs  int    `json:"duration_ms"`
	CreatedAt   string `json:"created_at"`
}

// TaskEvent mirrors the SSE frame (application.TaskEvent). Unlike TaskItem it
// carries ResultURLs (all assets for 组图 / n>1).
type TaskEvent struct {
	TaskID      string   `json:"task_id"`
	NodeID      string   `json:"node_id"`
	ServiceType string   `json:"service_type"`
	Status      string   `json:"status"`
	ResultURL   string   `json:"result_url"`
	ResultURLs  []string `json:"result_urls,omitempty"`
	ErrorMsg    string   `json:"error_msg"`
	DurationMs  int      `json:"duration_ms"`
}

// UploadResponse is the BARE JSON from POST /api/app/upload (NOT enveloped).
type UploadResponse struct {
	URL         string `json:"url"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
}

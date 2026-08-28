package application

import (
	"context"
	"encoding/json"
	"strings"

	"ccy-canvas/backend/internal/platform/database/sqlc"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	AgentUseModeSettingKey       = "creator_suite_agent_use_mode"
	AgentMemorySettingsKey       = "creator_suite_agent_memory_settings"
	AgentUseModeSimple     int32 = 0
	AgentUseModeAdvanced   int32 = 1
)

type CreatorSuiteAgentSeed struct {
	DeployKey       string
	ParentDeployKey string
	Name            string
	Description     string
	Avatar          string
	SystemPrompt    string
	Model           string
	ModelName       string
	ProviderID      string
	Temperature     float64
	MaxOutputTokens int32
	Runtime         string
	Enabled         bool
	CanvasTools     bool
	Strategy        string
	MetadataSource  string
}

type CreatorSuiteAgentSeedReport struct {
	Total    int `json:"total"`
	Created  int `json:"created"`
	Existing int `json:"existing"`
	Updated  int `json:"updated"`
}

type AgentRouteConfig struct {
	DeployKey       string  `json:"deploy_key"`
	ParentDeployKey string  `json:"parent_deploy_key"`
	Model           string  `json:"model"`
	ModelName       string  `json:"model_name"`
	ProviderID      string  `json:"provider_id"`
	Temperature     float64 `json:"temperature"`
	MaxOutputTokens int32   `json:"max_output_tokens"`
	Runtime         string  `json:"runtime"`
}

func creatorSuiteAgentSeeds() []CreatorSuiteAgentSeed {
	return []CreatorSuiteAgentSeed{
		mainAgentSeed("scriptAgent", "剧本 Agent", "读取原文、生成故事骨架和改编策略，适合文本理解与长文生成。", "script", "Doubao-Seed-1.8", "volcengine:doubao-seed-1-8-251228", "volcengine", "scriptAgent", true),
		mainAgentSeed("productionAgent", "生产 Agent", "调度工作流、拆分任务并监督执行，适合逻辑推理和任务管理。", "production", "Doubao-Seed-2.0-Pro", "volcengine:doubao-seed-2-0-pro-260215", "volcengine", "productionAgent", true),
		mainAgentSeed("universalAi", "通用 AI", "处理事件提取、资产提示词生成、台词提取等通用文本任务。", "general", "DeepSeek-V3-2", "volcengine:deepseek-v3-2-251201", "volcengine", "universalAi", true),
		mainAgentSeed("ttsDubbing", "TTS 配音", "根据剧本生成角色配音，待音频模型接入后启用。", "tts", "", "", "", "ttsDubbing", false),
		childAgentSeed("scriptAgent:decisionAgent", "scriptAgent", "剧本 Agent: 决策层", "分析用户意图并派发剧本阶段子任务。", "script_decision"),
		childAgentSeed("scriptAgent:supervisionAgent", "scriptAgent", "剧本 Agent: 监督层", "检查剧本阶段输出是否符合任务约束。", "script_supervision"),
		childAgentSeed("scriptAgent:storySkeletonAgent", "scriptAgent", "剧本 Agent: 故事骨架", "生成章节、事件和结构骨架。", "script_story_skeleton"),
		childAgentSeed("scriptAgent:adaptationStrategyAgent", "scriptAgent", "剧本 Agent: 改编策略", "把原文转为短剧/漫剧改编策略。", "script_adaptation"),
		childAgentSeed("scriptAgent:scriptAgent", "scriptAgent", "剧本 Agent: 剧本生成", "输出可执行分场剧本。", "script_generation"),
		childAgentSeed("productionAgent:decisionAgent", "productionAgent", "生产 Agent: 决策层", "分析画布状态并派发生产阶段子任务。", "production_decision"),
		childAgentSeed("productionAgent:supervisionAgent", "productionAgent", "生产 Agent: 监督层", "检查资产、分镜和画布执行结果。", "production_supervision"),
		childAgentSeed("productionAgent:deriveAssetsAgent", "productionAgent", "生产 Agent: 衍生资产", "从剧本和画布中提取角色、场景、道具等资产。", "production_derive_assets"),
		childAgentSeed("productionAgent:generateAssetsAgent", "productionAgent", "生产 Agent: 生成资产", "根据资产描述生成或补全视觉素材。", "production_generate_assets"),
		childAgentSeed("productionAgent:directorPlanAgent", "productionAgent", "生产 Agent: 导演规划", "规划镜头语言、节奏和画布节点编排。", "production_director_plan"),
		childAgentSeed("productionAgent:storyboardGenAgent", "productionAgent", "生产 Agent: 分镜生成", "生成分镜提示词和镜头描述。", "production_storyboard_gen"),
		childAgentSeed("productionAgent:storyboardPanelAgent", "productionAgent", "生产 Agent: 分镜面板", "生成可落地的分镜画面节点方案。", "production_storyboard_panel"),
		childAgentSeed("productionAgent:storyboardTableAgent", "productionAgent", "生产 Agent: 分镜表格", "整理分镜表格和生产排期数据。", "production_storyboard_table"),
	}
}

func mainAgentSeed(deployKey, name, description, avatar, model, modelName, providerID, runtime string, enabled bool) CreatorSuiteAgentSeed {
	return CreatorSuiteAgentSeed{
		DeployKey:       deployKey,
		Name:            name,
		Description:     description,
		Avatar:          avatar,
		SystemPrompt:    creatorSuiteSystemPrompt(name, description),
		Model:           model,
		ModelName:       modelName,
		ProviderID:      providerID,
		Temperature:     1,
		MaxOutputTokens: 0,
		Runtime:         runtime,
		Enabled:         enabled,
		CanvasTools:     true,
		Strategy:        "reactive",
		MetadataSource:  creatorSuiteSource,
	}
}

func childAgentSeed(deployKey, parentDeployKey, name, description, role string) CreatorSuiteAgentSeed {
	return CreatorSuiteAgentSeed{
		DeployKey:       deployKey,
		ParentDeployKey: parentDeployKey,
		Name:            name,
		Description:     description,
		Avatar:          role,
		SystemPrompt:    creatorSuiteSystemPrompt(name, description),
		Temperature:     1,
		MaxOutputTokens: 0,
		Runtime:         role,
		Enabled:         true,
		CanvasTools:     true,
		Strategy:        "reactive",
		MetadataSource:  creatorSuiteSource,
	}
}

func creatorSuiteSystemPrompt(name, description string) string {
	return strings.TrimSpace(name + "\n\n" + description + "\n\n你属于创作智能体套件。请基于当前画布、项目上下文、已激活技能和用户目标，输出清晰、可执行、可追踪的结果。")
}

func EnsureCreatorSuiteAgentSeeds(ctx context.Context, queries *sqlc.Queries) (CreatorSuiteAgentSeedReport, error) {
	seeds := creatorSuiteAgentSeeds()
	report := CreatorSuiteAgentSeedReport{Total: len(seeds)}

	for _, seed := range seeds {
		existing, err := queries.GetAgentByDeployKey(ctx, seed.DeployKey)
		if err != nil && err != pgx.ErrNoRows {
			return report, err
		}
		notFound := err == pgx.ErrNoRows
		params, err := seed.toInsertParams()
		if err != nil {
			return report, err
		}
		if notFound {
			if _, err := queries.InsertAgent(ctx, params); err != nil {
				return report, err
			}
			report.Created++
			continue
		}

		update := insertAgentParamsToUpdate(existing.ID, params)
		// 技能绑定是运营配置(管理员/脚本随时增删),seed 不拥有它 ——
		// 否则每次后端重启都会把 skill_ids 抹回空数组,绑定"莫名消失"。
		update.SkillIDs = existing.SkillIDs
		if agentSeedMatches(existing, update) {
			report.Existing++
			continue
		}
		if _, err := queries.UpdateAgent(ctx, update); err != nil {
			return report, err
		}
		report.Updated++
	}

	return report, nil
}

func (seed CreatorSuiteAgentSeed) toInsertParams() (sqlc.InsertAgentParams, error) {
	metadata, err := seedMetadata(seed)
	if err != nil {
		return sqlc.InsertAgentParams{}, err
	}
	return sqlc.InsertAgentParams{
		Scope:           "global",
		OwnerID:         pgtype.UUID{},
		Name:            seed.Name,
		Description:     seed.Description,
		Avatar:          seed.Avatar,
		SystemPrompt:    seed.SystemPrompt,
		Model:           seed.Model,
		SkillIDs:        []pgtype.UUID{},
		CanvasTools:     seed.CanvasTools,
		Strategy:        defaultStrategy(seed.Strategy),
		Enabled:         seed.Enabled,
		DeployKey:       seed.DeployKey,
		ParentDeployKey: seed.ParentDeployKey,
		ModelName:       seed.ModelName,
		ProviderID:      seed.ProviderID,
		Temperature:     defaultTemperature(seed.Temperature),
		MaxOutputTokens: seed.MaxOutputTokens,
		Runtime:         defaultRuntime(seed.Runtime),
		Metadata:        metadata,
	}, nil
}

func insertAgentParamsToUpdate(id pgtype.UUID, params sqlc.InsertAgentParams) sqlc.UpdateAgentParams {
	return sqlc.UpdateAgentParams{
		ID:              id,
		Name:            params.Name,
		Description:     params.Description,
		Avatar:          params.Avatar,
		SystemPrompt:    params.SystemPrompt,
		Model:           params.Model,
		SkillIDs:        params.SkillIDs,
		CanvasTools:     params.CanvasTools,
		Strategy:        params.Strategy,
		Enabled:         params.Enabled,
		DeployKey:       params.DeployKey,
		ParentDeployKey: params.ParentDeployKey,
		ModelName:       params.ModelName,
		ProviderID:      params.ProviderID,
		Temperature:     params.Temperature,
		MaxOutputTokens: params.MaxOutputTokens,
		Runtime:         params.Runtime,
		Metadata:        params.Metadata,
	}
}

func agentSeedMatches(agent sqlc.Agent, params sqlc.UpdateAgentParams) bool {
	return agent.Name == params.Name &&
		agent.Description == params.Description &&
		agent.Avatar == params.Avatar &&
		agent.SystemPrompt == params.SystemPrompt &&
		agent.Model == params.Model &&
		agent.CanvasTools == params.CanvasTools &&
		agent.Strategy == params.Strategy &&
		agent.Enabled == params.Enabled &&
		agent.DeployKey == params.DeployKey &&
		agent.ParentDeployKey == params.ParentDeployKey &&
		agent.ModelName == params.ModelName &&
		agent.ProviderID == params.ProviderID &&
		agent.Temperature == params.Temperature &&
		agent.MaxOutputTokens == params.MaxOutputTokens &&
		agent.Runtime == params.Runtime &&
		string(agent.Metadata) == string(params.Metadata)
}

func seedMetadata(seed CreatorSuiteAgentSeed) ([]byte, error) {
	role := "main"
	if seed.ParentDeployKey != "" {
		role = "child"
	}
	return json.Marshal(map[string]any{
		"source":            creatorSuiteSource,
		"suite":             "creator-suite",
		"role":              role,
		"deploy_key":        seed.DeployKey,
		"parent_deploy_key": seed.ParentDeployKey,
		"display_group":     "创作智能体套件",
	})
}

func defaultRuntime(value string) string {
	if value == "" {
		return "generic"
	}
	return value
}

func defaultStrategy(value string) string {
	if value == "" {
		return "reactive"
	}
	return value
}

func defaultTemperature(value float64) float64 {
	if value == 0 {
		return 1
	}
	return value
}

func ResolveCreatorSuiteRoute(useMode int32, exact AgentRouteConfig, parent AgentRouteConfig) AgentRouteConfig {
	if useMode == AgentUseModeAdvanced {
		if routeHasModel(exact) {
			return exact
		}
		return parent
	}
	if routeHasModel(parent) {
		merged := exact
		merged.Model = parent.Model
		merged.ModelName = parent.ModelName
		merged.ProviderID = parent.ProviderID
		merged.Temperature = parent.Temperature
		merged.MaxOutputTokens = parent.MaxOutputTokens
		return merged
	}
	return exact
}

func routeHasModel(route AgentRouteConfig) bool {
	return route.Model != "" || route.ModelName != ""
}

func AgentRouteConfigFromRow(agent sqlc.Agent) AgentRouteConfig {
	return AgentRouteConfig{
		DeployKey:       agent.DeployKey,
		ParentDeployKey: agent.ParentDeployKey,
		Model:           agent.Model,
		ModelName:       agent.ModelName,
		ProviderID:      agent.ProviderID,
		Temperature:     agent.Temperature,
		MaxOutputTokens: agent.MaxOutputTokens,
		Runtime:         agent.Runtime,
	}
}

func ResolveCatalogModelName(route AgentRouteConfig) string {
	modelName := strings.TrimSpace(route.ModelName)
	if modelName == "" {
		return strings.TrimSpace(route.Model)
	}
	if before, after, ok := strings.Cut(modelName, ":"); ok && before != "" && after != "" {
		return after
	}
	return modelName
}

package application

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLoadCreatorSuiteSkillSeedsIncludesAllMarkdownSkills(t *testing.T) {
	seeds, err := loadCreatorSuiteSkillSeeds()
	if err != nil {
		t.Fatalf("load creator-suite skill seeds: %v", err)
	}

	if got, want := len(seeds), 183; got != want {
		t.Fatalf("seed count = %d, want %d", got, want)
	}

	decision, ok := findCreatorSuiteSeed(seeds, "production_agent_decision.md")
	if !ok {
		t.Fatalf("production_agent_decision.md seed not found")
	}
	if decision.Name != "production_agent_decision" {
		t.Fatalf("seed name = %q", decision.Name)
	}
	if decision.Category != creatorSuiteSource {
		t.Fatalf("root seed category = %q, want %s", decision.Category, creatorSuiteSource)
	}
	if decision.SlashCommand != "creator-suite-production-agent-decision" {
		t.Fatalf("slash command = %q", decision.SlashCommand)
	}
	if decision.Kind != "code" {
		t.Fatalf("root skill kind = %q, want code", decision.Kind)
	}
	if decision.Content == "" {
		t.Fatalf("seed content should not be empty")
	}

	nested, ok := findCreatorSuiteSeed(seeds, "art_skills/2D_90s_japanese_anime/art_prompt/art_character.md")
	if !ok {
		t.Fatalf("nested art skill seed not found")
	}
	if nested.Category != "creator-suite/art_skills/2D_90s_japanese_anime/art_prompt" {
		t.Fatalf("nested category = %q", nested.Category)
	}
	if nested.SlashCommand != "creator-suite-art-skills-2d-90s-japanese-anime-art-prompt-art-character" {
		t.Fatalf("nested slash command = %q", nested.SlashCommand)
	}
	if nested.Kind != "code" {
		t.Fatalf("nested skill kind = %q, want code", nested.Kind)
	}
	if nested.Description == "" {
		t.Fatalf("seed description should be derived from markdown")
	}
}

func TestLoadCreatorSuitePromptSeedsIncludesDefaultPromptTemplates(t *testing.T) {
	seeds, err := loadCreatorSuitePromptSeeds()
	if err != nil {
		t.Fatalf("load creator-suite prompt seeds: %v", err)
	}

	if got, want := len(seeds), 4; got != want {
		t.Fatalf("prompt seed count = %d, want %d", got, want)
	}

	want := map[string]string{
		"prompts/eventExtraction.md":       "事件提取",
		"prompts/scriptAssetExtraction.md": "剧本资产提取",
		"prompts/videoPromptGeneration.md": "视频提示词生成",
		"prompts/audioBindPrompt.md":       "音色绑定",
	}
	for sourcePath, name := range want {
		seed, ok := findCreatorSuiteSeed(seeds, sourcePath)
		if !ok {
			t.Fatalf("prompt seed %s not found", sourcePath)
		}
		if seed.Name != name {
			t.Fatalf("prompt seed name = %q, want %q", seed.Name, name)
		}
		if seed.Kind != "prompt" {
			t.Fatalf("prompt seed kind = %q, want prompt", seed.Kind)
		}
		if seed.Category != "creator-suite/prompts" {
			t.Fatalf("prompt seed category = %q, want creator-suite/prompts", seed.Category)
		}
		if seed.SlashCommand != strings.TrimSuffix(strings.TrimPrefix(sourcePath, "prompts/"), ".md") {
			t.Fatalf("prompt slash command = %q", seed.SlashCommand)
		}
		if seed.Content == "" {
			t.Fatalf("prompt content for %s should not be empty", sourcePath)
		}
	}
}

func TestCreatorSuiteSeedSpecUsesNeutralMetadata(t *testing.T) {
	seed := creatorSuiteSkillSeed{
		Name:         "production_agent_decision",
		Description:  "decision skill",
		Category:     creatorSuiteSource,
		Kind:         "code",
		SlashCommand: "creator-suite-production-agent-decision",
		SourceType:   "skill",
		SourcePath:   "production_agent_decision.md",
		Content:      "# Decision",
	}

	specBytes, err := buildCreatorSuiteSeedSpec(seed)
	if err != nil {
		t.Fatalf("build spec: %v", err)
	}
	var spec map[string]any
	if err := json.Unmarshal(specBytes, &spec); err != nil {
		t.Fatalf("unmarshal spec: %v", err)
	}
	if spec["source"] != creatorSuiteSource {
		t.Fatalf("source = %v, want %s", spec["source"], creatorSuiteSource)
	}
	specText := string(specBytes)
	if strings.Contains(specText, legacySuiteSource) {
		t.Fatalf("spec should not contain legacy source marker: %s", specText)
	}
}

func TestCreatorSuiteAgentSeedsDefineMainAndChildAgents(t *testing.T) {
	seeds := creatorSuiteAgentSeeds()
	if got, want := len(seeds), 17; got != want {
		t.Fatalf("agent seed count = %d, want %d", got, want)
	}

	parents := map[string]int{}
	children := map[string]int{}
	for _, seed := range seeds {
		if seed.DeployKey == "" {
			t.Fatalf("agent seed %q has empty deploy key", seed.Name)
		}
		if strings.Contains(seed.MetadataSource, legacySuiteSource) {
			t.Fatalf("agent seed %q should not contain legacy source marker", seed.DeployKey)
		}
		if seed.ParentDeployKey == "" {
			parents[seed.DeployKey]++
		} else {
			children[seed.ParentDeployKey]++
		}
	}

	for _, key := range []string{"scriptAgent", "productionAgent", "universalAi", "ttsDubbing"} {
		if parents[key] != 1 {
			t.Fatalf("parent %s count = %d, want 1", key, parents[key])
		}
	}
	if children["scriptAgent"] != 5 {
		t.Fatalf("scriptAgent children = %d, want 5", children["scriptAgent"])
	}
	if children["productionAgent"] != 8 {
		t.Fatalf("productionAgent children = %d, want 8", children["productionAgent"])
	}
}

func TestResolveCreatorSuiteRouteSupportsSimpleAndAdvancedModes(t *testing.T) {
	parent := AgentRouteConfig{
		DeployKey:       "productionAgent",
		Model:           "Doubao-Seed-2.0-Pro",
		ModelName:       "volcengine:doubao-seed-2-0-pro-260215",
		ProviderID:      "volcengine",
		Temperature:     0.7,
		MaxOutputTokens: 4096,
	}
	child := AgentRouteConfig{
		DeployKey:       "productionAgent:storyboardGenAgent",
		ParentDeployKey: "productionAgent",
		Runtime:         "production_storyboard_gen",
		Temperature:     1,
	}

	simple := ResolveCreatorSuiteRoute(AgentUseModeSimple, child, parent)
	if simple.ModelName != parent.ModelName || simple.ProviderID != parent.ProviderID {
		t.Fatalf("simple route should inherit parent model, got %#v", simple)
	}
	if simple.Runtime != child.Runtime {
		t.Fatalf("simple route should preserve child runtime, got %q", simple.Runtime)
	}

	child.ModelName = "volcengine:deepseek-v3-2-251201"
	child.ProviderID = "volcengine"
	advanced := ResolveCreatorSuiteRoute(AgentUseModeAdvanced, child, parent)
	if advanced.ModelName != child.ModelName {
		t.Fatalf("advanced route should use exact child model, got %#v", advanced)
	}

	if got, want := ResolveCatalogModelName(advanced), "deepseek-v3-2-251201"; got != want {
		t.Fatalf("catalog model = %q, want %q", got, want)
	}
}

func findCreatorSuiteSeed(seeds []creatorSuiteSkillSeed, sourcePath string) (creatorSuiteSkillSeed, bool) {
	for _, seed := range seeds {
		if seed.SourcePath == sourcePath {
			return seed, true
		}
	}
	return creatorSuiteSkillSeed{}, false
}

package application

import (
	"strings"
	"testing"
)

func TestLoadToonflowSkillSeedsIncludesAllMarkdownSkills(t *testing.T) {
	seeds, err := loadToonflowSkillSeeds()
	if err != nil {
		t.Fatalf("load Toonflow skill seeds: %v", err)
	}

	if got, want := len(seeds), 183; got != want {
		t.Fatalf("seed count = %d, want %d", got, want)
	}

	decision, ok := findToonflowSeed(seeds, "production_agent_decision.md")
	if !ok {
		t.Fatalf("production_agent_decision.md seed not found")
	}
	if decision.Name != "production_agent_decision" {
		t.Fatalf("seed name = %q", decision.Name)
	}
	if decision.Category != "toonflow" {
		t.Fatalf("root seed category = %q, want toonflow", decision.Category)
	}
	if decision.SlashCommand != "toonflow-production-agent-decision" {
		t.Fatalf("slash command = %q", decision.SlashCommand)
	}
	if decision.Kind != "code" {
		t.Fatalf("root Toonflow skill kind = %q, want code", decision.Kind)
	}
	if decision.Content == "" {
		t.Fatalf("seed content should not be empty")
	}

	nested, ok := findToonflowSeed(seeds, "art_skills/2D_90s_japanese_anime/art_prompt/art_character.md")
	if !ok {
		t.Fatalf("nested art skill seed not found")
	}
	if nested.Category != "toonflow/art_skills/2D_90s_japanese_anime/art_prompt" {
		t.Fatalf("nested category = %q", nested.Category)
	}
	if nested.SlashCommand != "toonflow-art-skills-2d-90s-japanese-anime-art-prompt-art-character" {
		t.Fatalf("nested slash command = %q", nested.SlashCommand)
	}
	if nested.Kind != "code" {
		t.Fatalf("nested Toonflow skill kind = %q, want code", nested.Kind)
	}
	if nested.Description == "" {
		t.Fatalf("seed description should be derived from markdown")
	}
}

func TestLoadToonflowPromptSeedsIncludesDefaultPromptTemplates(t *testing.T) {
	seeds, err := loadToonflowPromptSeeds()
	if err != nil {
		t.Fatalf("load Toonflow prompt seeds: %v", err)
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
		seed, ok := findToonflowSeed(seeds, sourcePath)
		if !ok {
			t.Fatalf("prompt seed %s not found", sourcePath)
		}
		if seed.Name != name {
			t.Fatalf("prompt seed name = %q, want %q", seed.Name, name)
		}
		if seed.Kind != "prompt" {
			t.Fatalf("prompt seed kind = %q, want prompt", seed.Kind)
		}
		if seed.Category != "toonflow/prompts" {
			t.Fatalf("prompt seed category = %q, want toonflow/prompts", seed.Category)
		}
		if seed.SlashCommand != strings.TrimSuffix(strings.TrimPrefix(sourcePath, "prompts/"), ".md") {
			t.Fatalf("prompt slash command = %q", seed.SlashCommand)
		}
		if seed.Content == "" {
			t.Fatalf("prompt content for %s should not be empty", sourcePath)
		}
	}
}

func findToonflowSeed(seeds []toonflowSkillSeed, path string) (toonflowSkillSeed, bool) {
	for _, seed := range seeds {
		if seed.SourcePath == path {
			return seed, true
		}
	}
	return toonflowSkillSeed{}, false
}

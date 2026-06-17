package application

import "testing"

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
	if nested.Description == "" {
		t.Fatalf("seed description should be derived from markdown")
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

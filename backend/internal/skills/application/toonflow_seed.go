package application

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"

	"ccy-canvas/backend/internal/platform/database/sqlc"

	"github.com/jackc/pgx/v5/pgtype"
)

//go:embed seeds/toonflow_skills seeds/toonflow_prompts
var toonflowSeedFS embed.FS

type toonflowSkillSeed struct {
	Name         string
	Description  string
	Category     string
	Kind         string
	Icon         string
	SlashCommand string
	SourceType   string
	SourcePath   string
	Content      string
}

type ToonflowSkillSeedReport struct {
	Total    int
	Created  int
	Existing int
	Updated  int
}

func EnsureToonflowSkillSeeds(ctx context.Context, queries *sqlc.Queries) (ToonflowSkillSeedReport, error) {
	seeds, err := loadAllToonflowSeeds()
	if err != nil {
		return ToonflowSkillSeedReport{}, err
	}
	report := ToonflowSkillSeedReport{Total: len(seeds)}

	existingSkills, err := queries.ListAllSkills(ctx)
	if err != nil {
		return report, err
	}
	existingBySeed := make(map[string]sqlc.Skill, len(existingSkills))
	existingByName := make(map[string]sqlc.Skill, len(existingSkills))
	for _, skill := range existingSkills {
		existingByName[skill.Category+"/"+skill.Name] = skill

		var spec struct {
			Source     string `json:"source"`
			SourceType string `json:"source_type"`
			SourcePath string `json:"source_path"`
		}
		if err := json.Unmarshal(skill.Spec, &spec); err == nil && spec.Source == "toonflow" && spec.SourcePath != "" {
			sourceType := spec.SourceType
			if sourceType == "" {
				sourceType = inferToonflowSeedSourceType(spec.SourcePath)
			}
			existingBySeed[toonflowSeedKey(sourceType, spec.SourcePath)] = skill
		}
	}

	for _, seed := range seeds {
		seedKey := toonflowSeedKey(seed.SourceType, seed.SourcePath)
		if existing, ok := existingBySeed[seedKey]; ok {
			updated, err := syncToonflowSeed(ctx, queries, existing, seed)
			if err != nil {
				return report, err
			}
			if updated {
				report.Updated++
			} else {
				report.Existing++
			}
			continue
		}
		if _, ok := existingByName[seed.Category+"/"+seed.Name]; ok {
			report.Existing++
			continue
		}

		spec, err := buildToonflowSeedSpec(seed)
		if err != nil {
			return report, err
		}

		if _, err := queries.InsertSkill(ctx, sqlc.InsertSkillParams{
			Scope:        "global",
			OwnerID:      pgtype.UUID{},
			Name:         seed.Name,
			Description:  seed.Description,
			Category:     seed.Category,
			Icon:         seed.Icon,
			Kind:         seed.Kind,
			Spec:         spec,
			InputSchema:  []byte(`{"type":"object","properties":{"input":{"type":"string"}}}`),
			OutputSchema: []byte(`{"type":"object","properties":{"result":{"type":"string"}}}`),
			Enabled:      true,
		}); err != nil {
			return report, err
		}
		report.Created++
		existingBySeed[seedKey] = sqlc.Skill{}
		existingByName[seed.Category+"/"+seed.Name] = sqlc.Skill{}
	}

	return report, nil
}

func loadAllToonflowSeeds() ([]toonflowSkillSeed, error) {
	skills, err := loadToonflowSkillSeeds()
	if err != nil {
		return nil, err
	}
	prompts, err := loadToonflowPromptSeeds()
	if err != nil {
		return nil, err
	}
	seeds := append(skills, prompts...)
	sort.Slice(seeds, func(i, j int) bool {
		return toonflowSeedKey(seeds[i].SourceType, seeds[i].SourcePath) < toonflowSeedKey(seeds[j].SourceType, seeds[j].SourcePath)
	})
	return seeds, nil
}

func loadToonflowSkillSeeds() ([]toonflowSkillSeed, error) {
	const root = "seeds/toonflow_skills"

	var seeds []toonflowSkillSeed
	if err := fs.WalkDir(toonflowSeedFS, root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.EqualFold(path.Ext(filePath), ".md") {
			return nil
		}

		contentBytes, err := toonflowSeedFS.ReadFile(filePath)
		if err != nil {
			return err
		}
		sourcePath := strings.TrimPrefix(strings.TrimPrefix(filePath, root), "/")
		name := strings.TrimSuffix(path.Base(sourcePath), path.Ext(sourcePath))
		category := "toonflow"
		if dir := path.Dir(sourcePath); dir != "." {
			category += "/" + dir
		}

		content := strings.TrimSpace(string(contentBytes))
		seeds = append(seeds, toonflowSkillSeed{
			Name:         name,
			Description:  deriveMarkdownDescription(content, name),
			Category:     category,
			Kind:         "code",
			Icon:         "sparkles",
			SlashCommand: "toonflow-" + slugifySkillPath(strings.TrimSuffix(sourcePath, path.Ext(sourcePath))),
			SourceType:   "skill",
			SourcePath:   sourcePath,
			Content:      content,
		})
		return nil
	}); err != nil {
		return nil, err
	}

	sort.Slice(seeds, func(i, j int) bool {
		return seeds[i].SourcePath < seeds[j].SourcePath
	})
	return seeds, nil
}

var toonflowPromptSeedNames = map[string]string{
	"eventExtraction":       "事件提取",
	"scriptAssetExtraction": "剧本资产提取",
	"videoPromptGeneration": "视频提示词生成",
	"audioBindPrompt":       "音色绑定",
}

func loadToonflowPromptSeeds() ([]toonflowSkillSeed, error) {
	const root = "seeds/toonflow_prompts"

	var seeds []toonflowSkillSeed
	if err := fs.WalkDir(toonflowSeedFS, root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.EqualFold(path.Ext(filePath), ".md") {
			return nil
		}

		contentBytes, err := toonflowSeedFS.ReadFile(filePath)
		if err != nil {
			return err
		}
		promptType := strings.TrimSuffix(path.Base(filePath), path.Ext(filePath))
		name := toonflowPromptSeedNames[promptType]
		if name == "" {
			name = promptType
		}
		content := strings.TrimSpace(string(contentBytes))
		seeds = append(seeds, toonflowSkillSeed{
			Name:         name,
			Description:  deriveMarkdownDescription(content, name),
			Category:     "toonflow/prompts",
			Kind:         "prompt",
			Icon:         "file-text",
			SlashCommand: promptType,
			SourceType:   "prompt",
			SourcePath:   "prompts/" + promptType + ".md",
			Content:      content,
		})
		return nil
	}); err != nil {
		return nil, err
	}

	sort.Slice(seeds, func(i, j int) bool {
		return seeds[i].SourcePath < seeds[j].SourcePath
	})
	return seeds, nil
}

func buildToonflowSeedSpec(seed toonflowSkillSeed) ([]byte, error) {
	spec := map[string]any{
		"source":       "toonflow",
		"source_type":  seed.SourceType,
		"source_path":  seed.SourcePath,
		"content_md":   seed.Content,
		"trigger_mode": "manual",
	}
	if seed.Kind == "prompt" {
		spec["prompt_type"] = strings.TrimSuffix(path.Base(seed.SourcePath), path.Ext(seed.SourcePath))
		spec["slash_command"] = seed.SlashCommand
		spec["user_template"] = seed.Content
		spec["trigger_mode"] = "slash"
	}
	return json.Marshal(spec)
}

func syncToonflowSeed(ctx context.Context, queries *sqlc.Queries, existing sqlc.Skill, seed toonflowSkillSeed) (bool, error) {
	spec, err := buildToonflowSeedSpec(seed)
	if err != nil {
		return false, err
	}
	if existing.Name == seed.Name &&
		existing.Description == seed.Description &&
		existing.Category == seed.Category &&
		existing.Icon == seed.Icon &&
		existing.Kind == seed.Kind &&
		string(existing.Spec) == string(spec) {
		return false, nil
	}

	if _, err := queries.UpdateSkill(ctx, sqlc.UpdateSkillParams{
		ID:           existing.ID,
		Name:         seed.Name,
		Description:  seed.Description,
		Category:     seed.Category,
		Icon:         seed.Icon,
		Kind:         seed.Kind,
		Spec:         spec,
		InputSchema:  existing.InputSchema,
		OutputSchema: existing.OutputSchema,
		Enabled:      existing.Enabled,
	}); err != nil {
		return false, err
	}
	return true, nil
}

func inferToonflowSeedSourceType(sourcePath string) string {
	if strings.HasPrefix(sourcePath, "prompts/") {
		return "prompt"
	}
	return "skill"
}

func toonflowSeedKey(sourceType string, sourcePath string) string {
	return sourceType + ":" + sourcePath
}

func deriveMarkdownDescription(content string, fallback string) string {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "---") || strings.HasPrefix(trimmed, "```") {
			continue
		}
		trimmed = strings.TrimLeft(trimmed, "# ")
		trimmed = strings.TrimSpace(trimmed)
		if trimmed != "" {
			if len([]rune(trimmed)) > 120 {
				return string([]rune(trimmed)[:120]) + "..."
			}
			return trimmed
		}
	}
	return fallback
}

var skillSlugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugifySkillPath(value string) string {
	slug := strings.ToLower(value)
	slug = skillSlugRe.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	for strings.Contains(slug, "--") {
		slug = strings.ReplaceAll(slug, "--", "-")
	}
	return slug
}

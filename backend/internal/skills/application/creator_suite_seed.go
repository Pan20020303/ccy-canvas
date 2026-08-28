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

const creatorSuiteSource = "creator-suite"

var legacySuiteSource = "toon" + "flow"

//go:embed seeds/creator_suite_skills seeds/creator_suite_prompts
var creatorSuiteSeedFS embed.FS

type creatorSuiteSkillSeed struct {
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

type CreatorSuiteSeedReport struct {
	Total    int `json:"total"`
	Created  int `json:"created"`
	Existing int `json:"existing"`
	Updated  int `json:"updated"`
}

func EnsureCreatorSuiteSeeds(ctx context.Context, queries *sqlc.Queries) (CreatorSuiteSeedReport, error) {
	seeds, err := loadAllCreatorSuiteSeeds()
	if err != nil {
		return CreatorSuiteSeedReport{}, err
	}
	report := CreatorSuiteSeedReport{Total: len(seeds)}

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
		if err := json.Unmarshal(skill.Spec, &spec); err == nil && isCreatorSuiteSource(spec.Source) && spec.SourcePath != "" {
			sourceType := spec.SourceType
			if sourceType == "" {
				sourceType = inferCreatorSuiteSeedSourceType(spec.SourcePath)
			}
			existingBySeed[creatorSuiteSeedKey(sourceType, spec.SourcePath)] = skill
		}
	}

	for _, seed := range seeds {
		seedKey := creatorSuiteSeedKey(seed.SourceType, seed.SourcePath)
		if existing, ok := existingBySeed[seedKey]; ok {
			updated, err := syncCreatorSuiteSeed(ctx, queries, existing, seed)
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

		spec, err := buildCreatorSuiteSeedSpec(seed)
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

func loadAllCreatorSuiteSeeds() ([]creatorSuiteSkillSeed, error) {
	skills, err := loadCreatorSuiteSkillSeeds()
	if err != nil {
		return nil, err
	}
	prompts, err := loadCreatorSuitePromptSeeds()
	if err != nil {
		return nil, err
	}
	seeds := append(skills, prompts...)
	sort.Slice(seeds, func(i, j int) bool {
		return creatorSuiteSeedKey(seeds[i].SourceType, seeds[i].SourcePath) < creatorSuiteSeedKey(seeds[j].SourceType, seeds[j].SourcePath)
	})
	return seeds, nil
}

func loadCreatorSuiteSkillSeeds() ([]creatorSuiteSkillSeed, error) {
	const root = "seeds/creator_suite_skills"

	var seeds []creatorSuiteSkillSeed
	if err := fs.WalkDir(creatorSuiteSeedFS, root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.EqualFold(path.Ext(filePath), ".md") {
			return nil
		}

		contentBytes, err := creatorSuiteSeedFS.ReadFile(filePath)
		if err != nil {
			return err
		}
		sourcePath := strings.TrimPrefix(strings.TrimPrefix(filePath, root), "/")
		name := strings.TrimSuffix(path.Base(sourcePath), path.Ext(sourcePath))
		category := creatorSuiteSource
		if dir := path.Dir(sourcePath); dir != "." {
			category += "/" + dir
		}

		content := strings.TrimSpace(string(contentBytes))
		seeds = append(seeds, creatorSuiteSkillSeed{
			Name:         name,
			Description:  deriveMarkdownDescription(content, name),
			Category:     category,
			Kind:         "code",
			Icon:         "sparkles",
			SlashCommand: creatorSuiteSource + "-" + slugifySkillPath(strings.TrimSuffix(sourcePath, path.Ext(sourcePath))),
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

var creatorSuitePromptSeedNames = map[string]string{
	"eventExtraction":       "事件提取",
	"scriptAssetExtraction": "剧本资产提取",
	"videoPromptGeneration": "视频提示词生成",
	"audioBindPrompt":       "音色绑定",
}

func loadCreatorSuitePromptSeeds() ([]creatorSuiteSkillSeed, error) {
	const root = "seeds/creator_suite_prompts"

	var seeds []creatorSuiteSkillSeed
	if err := fs.WalkDir(creatorSuiteSeedFS, root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.EqualFold(path.Ext(filePath), ".md") {
			return nil
		}

		contentBytes, err := creatorSuiteSeedFS.ReadFile(filePath)
		if err != nil {
			return err
		}
		promptType := strings.TrimSuffix(path.Base(filePath), path.Ext(filePath))
		name := creatorSuitePromptSeedNames[promptType]
		if name == "" {
			name = promptType
		}
		content := strings.TrimSpace(string(contentBytes))
		seeds = append(seeds, creatorSuiteSkillSeed{
			Name:         name,
			Description:  deriveMarkdownDescription(content, name),
			Category:     creatorSuiteSource + "/prompts",
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

func buildCreatorSuiteSeedSpec(seed creatorSuiteSkillSeed) ([]byte, error) {
	spec := map[string]any{
		"source":       creatorSuiteSource,
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

func syncCreatorSuiteSeed(ctx context.Context, queries *sqlc.Queries, existing sqlc.Skill, seed creatorSuiteSkillSeed) (bool, error) {
	spec, err := buildCreatorSuiteSeedSpec(seed)
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

func isCreatorSuiteSource(source string) bool {
	return source == creatorSuiteSource || source == legacySuiteSource
}

func inferCreatorSuiteSeedSourceType(sourcePath string) string {
	if strings.HasPrefix(sourcePath, "prompts/") {
		return "prompt"
	}
	return "skill"
}

func creatorSuiteSeedKey(sourceType string, sourcePath string) string {
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

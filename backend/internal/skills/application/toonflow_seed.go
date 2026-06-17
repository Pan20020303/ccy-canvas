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

//go:embed seeds/toonflow_skills
var toonflowSeedFS embed.FS

type toonflowSkillSeed struct {
	Name         string
	Description  string
	Category     string
	SlashCommand string
	SourcePath   string
	Content      string
}

type ToonflowSkillSeedReport struct {
	Total    int
	Created  int
	Existing int
}

func EnsureToonflowSkillSeeds(ctx context.Context, queries *sqlc.Queries) (ToonflowSkillSeedReport, error) {
	seeds, err := loadToonflowSkillSeeds()
	if err != nil {
		return ToonflowSkillSeedReport{}, err
	}
	report := ToonflowSkillSeedReport{Total: len(seeds)}

	existingSkills, err := queries.ListAllSkills(ctx)
	if err != nil {
		return report, err
	}
	existing := make(map[string]struct{}, len(existingSkills))
	for _, skill := range existingSkills {
		key := skill.Category + "/" + skill.Name
		existing[key] = struct{}{}

		var spec struct {
			Source     string `json:"source"`
			SourcePath string `json:"source_path"`
		}
		if err := json.Unmarshal(skill.Spec, &spec); err == nil && spec.Source == "toonflow" && spec.SourcePath != "" {
			existing["toonflow:"+spec.SourcePath] = struct{}{}
		}
	}

	for _, seed := range seeds {
		if _, ok := existing["toonflow:"+seed.SourcePath]; ok {
			report.Existing++
			continue
		}
		if _, ok := existing[seed.Category+"/"+seed.Name]; ok {
			report.Existing++
			continue
		}

		spec, err := json.Marshal(map[string]any{
			"source":        "toonflow",
			"source_path":   seed.SourcePath,
			"slash_command": seed.SlashCommand,
			"content_md":    seed.Content,
			"user_template": seed.Content,
			"trigger_mode":  "slash",
		})
		if err != nil {
			return report, err
		}

		if _, err := queries.InsertSkill(ctx, sqlc.InsertSkillParams{
			Scope:        "global",
			OwnerID:      pgtype.UUID{},
			Name:         seed.Name,
			Description:  seed.Description,
			Category:     seed.Category,
			Icon:         "sparkles",
			Kind:         "prompt",
			Spec:         spec,
			InputSchema:  []byte(`{"type":"object","properties":{"input":{"type":"string"}}}`),
			OutputSchema: []byte(`{"type":"object","properties":{"result":{"type":"string"}}}`),
			Enabled:      true,
		}); err != nil {
			return report, err
		}
		report.Created++
		existing["toonflow:"+seed.SourcePath] = struct{}{}
		existing[seed.Category+"/"+seed.Name] = struct{}{}
	}

	return report, nil
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
			SlashCommand: "toonflow-" + slugifySkillPath(strings.TrimSuffix(sourcePath, path.Ext(sourcePath))),
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

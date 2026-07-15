import type { SkillUpsert } from "../../api/skills";
import { buildPromptSkillSpec } from "./skill-agent-presenters";

/**
 * Parse a Markdown skill file (Claude-style) into a SkillUpsert payload.
 *
 * Recognized frontmatter (YAML between leading `---` fences):
 *   name        → skill display name (also used to derive slash command)
 *   description → one-liner shown in the skill list
 *   category    → freeform category tag (defaults to "workflow")
 *   command     → explicit slash command (defaults to slugified name)
 *   model       → optional model hint
 *   system      → optional system prompt
 *
 * The body after the frontmatter becomes the template content.
 */
export function parseSkillMarkdown(raw: string, fallbackName = "imported-skill"): SkillUpsert {
  const { frontmatter, body } = splitFrontmatter(raw);

  const name = (frontmatter.name ?? fallbackName).trim() || fallbackName;
  const description = (frontmatter.description ?? "").trim();
  const category = (frontmatter.category ?? "workflow").trim() || "workflow";
  const commandName = (frontmatter.command ?? slugify(name)).trim();
  const systemPrompt = (frontmatter.system ?? "").trim();
  const modelHint = (frontmatter.model ?? "").trim();
  const content = body.trim();

  return {
    name,
    description,
    category,
    icon: "",
    kind: "prompt",
    spec: buildPromptSkillSpec({ commandName, content, systemPrompt, modelHint }),
    input_schema: {
      type: "object",
      properties: { input: { type: "string" } },
    },
    output_schema: {},
    enabled: true,
  };
}

/**
 * Fetch a skill from a URL. Most raw GitHub / gist / public docs URLs allow
 * cross-origin GETs; for blocked origins the caller should fall back to a
 * paste dialog.
 */
export async function fetchSkillMarkdown(url: string): Promise<string> {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

// ─── internals ──────────────────────────────────────────────────────────────

function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const trimmed = raw.replace(/^﻿/, ""); // strip BOM
  const match = trimmed.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: trimmed };
  }
  return {
    frontmatter: parseFrontmatter(match[1]),
    body: match[2],
  };
}

// Minimal YAML-ish parser: supports `key: value` per line. Values may be
// quoted with " or ' and span single lines. Lists / nested objects aren't
// supported — skill metadata never needs them.
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "imported-skill";
}

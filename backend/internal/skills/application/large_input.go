package application

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"ccy-canvas/backend/internal/shared/apperror"
)

// DefaultAgentInputChunkRunes deliberately leaves room for the system prompt,
// tool schemas and the model's tool-call output. A chunk may contain many
// generation prompts, and those prompts have to appear once in the request and
// again in create_generation_batch arguments, so using the provider's entire
// context window for input is not safe.
const DefaultAgentInputChunkRunes = 120_000

// MaxAgentHistoryRunes prevents old pasted documents from silently consuming
// the next turn's context window. Newest turns win; the current user message is
// never trimmed here because RunAdaptive handles it with semantic segmentation.
const MaxAgentHistoryRunes = 80_000

type AgentInputSegment struct {
	Content string
	Label   string
}

var markdownHeadingRE = regexp.MustCompile(`^(#{1,6})[\t ]+(.+?)[\t ]*$`)

type markdownHeading struct {
	start int
	level int
	label string
}

// SplitAgentInput splits an oversized document without asking the LLM to read
// a request it cannot receive. It prefers Markdown volume/entry boundaries,
// then paragraphs, then UTF-8-safe hard boundaries. Parent heading context is
// repeated when a large section is split, but entry bodies never overlap.
func SplitAgentInput(text string, maxRunes int) []AgentInputSegment {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	if maxRunes <= 0 {
		maxRunes = DefaultAgentInputChunkRunes
	}
	if utf8.RuneCountInString(text) <= maxRunes {
		return []AgentInputSegment{{Content: text, Label: firstHeadingLabel(text)}}
	}

	headings := markdownHeadings(text)
	if len(headings) == 0 {
		return labelSegments(splitByParagraphs(text, maxRunes), "正文")
	}
	baseLevel := headings[0].level
	for _, heading := range headings[1:] {
		if heading.level < baseLevel {
			baseLevel = heading.level
		}
	}
	sections := splitAtHeadingLevel(text, headings, baseLevel)
	segments := make([]AgentInputSegment, 0, len(sections))
	for _, section := range sections {
		segments = append(segments, splitMarkdownSection(section, maxRunes)...)
	}
	return segments
}

func splitMarkdownSection(section string, maxRunes int) []AgentInputSegment {
	section = strings.TrimSpace(section)
	label := firstHeadingLabel(section)
	if utf8.RuneCountInString(section) <= maxRunes {
		return []AgentInputSegment{{Content: section, Label: label}}
	}

	headings := markdownHeadings(section)
	if len(headings) < 2 {
		return labelSegments(splitByParagraphs(section, maxRunes), label)
	}
	baseLevel := headings[0].level
	childLevel := 7
	for _, heading := range headings[1:] {
		if heading.level > baseLevel && heading.level < childLevel {
			childLevel = heading.level
		}
	}
	if childLevel == 7 {
		return labelSegments(splitByParagraphs(section, maxRunes), label)
	}

	childStarts := make([]int, 0)
	for _, heading := range headings[1:] {
		if heading.level == childLevel {
			childStarts = append(childStarts, heading.start)
		}
	}
	if len(childStarts) == 0 {
		return labelSegments(splitByParagraphs(section, maxRunes), label)
	}
	prefix := strings.TrimSpace(section[:childStarts[0]])
	children := make([]string, 0, len(childStarts))
	for index, start := range childStarts {
		end := len(section)
		if index+1 < len(childStarts) {
			end = childStarts[index+1]
		}
		children = append(children, strings.TrimSpace(section[start:end]))
	}

	available := maxRunes - utf8.RuneCountInString(prefix) - 2
	if available < maxRunes/4 {
		// An unusually large parent preamble is content in its own right. Split
		// it once instead of repeating most of the document in every segment.
		parts := labelSegments(splitByParagraphs(prefix, maxRunes), label)
		prefix = ""
		available = maxRunes
		return append(parts, packChildSections(prefix, children, available, maxRunes, label)...)
	}
	return packChildSections(prefix, children, available, maxRunes, label)
}

func packChildSections(prefix string, children []string, available, maxRunes int, label string) []AgentInputSegment {
	var packed []string
	var current strings.Builder
	flush := func() {
		body := strings.TrimSpace(current.String())
		if body == "" {
			return
		}
		content := body
		if prefix != "" {
			content = prefix + "\n\n" + body
		}
		packed = append(packed, content)
		current.Reset()
	}
	for _, child := range children {
		childRunes := utf8.RuneCountInString(child)
		if childRunes > available {
			flush()
			for _, part := range splitByParagraphs(child, available) {
				content := part
				if prefix != "" {
					content = prefix + "\n\n" + part
				}
				packed = append(packed, content)
			}
			continue
		}
		separator := 0
		if current.Len() > 0 {
			separator = 2
		}
		if utf8.RuneCountInString(current.String())+separator+childRunes > available {
			flush()
		}
		if current.Len() > 0 {
			current.WriteString("\n\n")
		}
		current.WriteString(child)
	}
	flush()
	return labelSegments(packed, label)
}

func splitAtHeadingLevel(text string, headings []markdownHeading, level int) []string {
	starts := make([]int, 0)
	for _, heading := range headings {
		if heading.level == level {
			starts = append(starts, heading.start)
		}
	}
	if len(starts) == 0 {
		return []string{text}
	}
	sections := make([]string, 0, len(starts))
	for index, start := range starts {
		if index == 0 && start > 0 {
			start = 0
		}
		end := len(text)
		if index+1 < len(starts) {
			end = starts[index+1]
		}
		sections = append(sections, strings.TrimSpace(text[start:end]))
	}
	return sections
}

func markdownHeadings(text string) []markdownHeading {
	var headings []markdownHeading
	inFence := false
	offset := 0
	for _, lineWithNewline := range strings.SplitAfter(text, "\n") {
		line := strings.TrimSuffix(lineWithNewline, "\n")
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			offset += len(lineWithNewline)
			continue
		}
		if !inFence {
			if match := markdownHeadingRE.FindStringSubmatch(line); len(match) == 3 {
				headings = append(headings, markdownHeading{
					start: offset,
					level: len(match[1]),
					label: strings.TrimSpace(match[2]),
				})
			}
		}
		offset += len(lineWithNewline)
	}
	return headings
}

func splitByParagraphs(text string, maxRunes int) []string {
	if maxRunes < 1 {
		maxRunes = 1
	}
	paragraphs := strings.Split(strings.TrimSpace(text), "\n\n")
	var result []string
	var current strings.Builder
	flush := func() {
		if part := strings.TrimSpace(current.String()); part != "" {
			result = append(result, part)
		}
		current.Reset()
	}
	for _, paragraph := range paragraphs {
		paragraph = strings.TrimSpace(paragraph)
		if paragraph == "" {
			continue
		}
		if utf8.RuneCountInString(paragraph) > maxRunes {
			flush()
			result = append(result, hardSplitRunes(paragraph, maxRunes)...)
			continue
		}
		separator := 0
		if current.Len() > 0 {
			separator = 2
		}
		if utf8.RuneCountInString(current.String())+separator+utf8.RuneCountInString(paragraph) > maxRunes {
			flush()
		}
		if current.Len() > 0 {
			current.WriteString("\n\n")
		}
		current.WriteString(paragraph)
	}
	flush()
	return result
}

func hardSplitRunes(text string, maxRunes int) []string {
	runes := []rune(text)
	parts := make([]string, 0, (len(runes)+maxRunes-1)/maxRunes)
	for start := 0; start < len(runes); start += maxRunes {
		end := start + maxRunes
		if end > len(runes) {
			end = len(runes)
		}
		parts = append(parts, string(runes[start:end]))
	}
	return parts
}

func labelSegments(parts []string, label string) []AgentInputSegment {
	segments := make([]AgentInputSegment, 0, len(parts))
	for index, part := range parts {
		partLabel := label
		if len(parts) > 1 {
			partLabel = fmt.Sprintf("%s（片段 %d/%d）", label, index+1, len(parts))
		}
		segments = append(segments, AgentInputSegment{Content: part, Label: partLabel})
	}
	return segments
}

func firstHeadingLabel(text string) string {
	if headings := markdownHeadings(text); len(headings) > 0 {
		return headings[0].label
	}
	return "正文"
}

// RunAdaptive executes normal requests unchanged and oversized requests as
// independent semantic segments. Segment-local LLM transcripts are discarded
// so one segment cannot push the next over the context limit; canvas/tool state
// remains shared, so successfully created nodes remain available.
func (r *Runner) RunAdaptive(ctx context.Context, in RunInput, emit func(string, any)) (RunStats, error) {
	segments := SplitAgentInput(in.UserMessage, DefaultAgentInputChunkRunes)
	if len(segments) <= 1 {
		return r.Run(ctx, in, emit)
	}

	emit(EventThought, map[string]string{"content": fmt.Sprintf(
		"检测到超大文本，已按分卷、条目标题和段落自动拆为 %d 段；各段互不重叠，将逐段执行。", len(segments),
	)})

	combined := RunStats{}
	replies := make([]string, 0, len(segments))
	for index, segment := range segments {
		emit(EventThought, map[string]string{"content": fmt.Sprintf(
			"正在处理第 %d/%d 段：%s", index+1, len(segments), segment.Label,
		)})
		segmentInput := in
		segmentInput.History = nil
		segmentInput.UserMessage = fmt.Sprintf(
			"【系统分段 %d/%d】以下是原始请求的一个独立语义段。只处理本段明确包含的条目，不要补齐、猜测或重复其它段。若任务要求批量创建生成节点，使用 create_generation_batch，并把本段每个条目的完整提示词和用户指定模型写入节点。\n\n%s",
			index+1, len(segments), segment.Content,
		)

		segmentStats, err := r.Run(ctx, segmentInput, func(event string, data any) {
			switch event {
			case "message_delta", EventMessage, EventDone, EventError:
				// Only one coherent terminal reply is emitted after all segments.
				return
			default:
				emit(event, data)
			}
		})
		combined.Steps += segmentStats.Steps
		combined.ToolCalls += segmentStats.ToolCalls
		combined.Usage = segmentStats.Usage
		combined.ToolTranscript = append(combined.ToolTranscript, segmentStats.ToolTranscript...)
		if strings.TrimSpace(segmentStats.FinalReply) != "" {
			replies = append(replies, fmt.Sprintf("第 %d/%d 段：%s", index+1, len(segments), strings.TrimSpace(segmentStats.FinalReply)))
		}
		if err != nil {
			combined.FinalReply = combineSegmentReplies(replies, index, len(segments))
			if index == 0 {
				return combined, err
			}
			publicCause := apperror.PublicMessage(err)
			message := fmt.Sprintf(
				"大文本已完成 %d/%d 段，第 %d 段（%s）失败：%s。前 %d 段的画布操作已经生效，请勿整单重试，以免重复创建。",
				index, len(segments), index+1, segment.Label, publicCause, index,
			)
			return combined, apperror.Wrap(apperror.CodeUpstreamUnavailable, message, err)
		}
		emit(EventThought, map[string]string{"content": fmt.Sprintf("第 %d/%d 段处理完成。", index+1, len(segments))})
	}

	combined.FinalReply = combineSegmentReplies(replies, len(segments), len(segments))
	emit(EventMessage, map[string]string{"content": combined.FinalReply})
	emit(EventDone, map[string]int{"steps": combined.Steps})
	return combined, nil
}

func combineSegmentReplies(replies []string, completed, total int) string {
	header := fmt.Sprintf("大文本已自动分段处理完成：%d/%d 段。", completed, total)
	if len(replies) == 0 {
		return header
	}
	const maxReplyRunes = 20_000
	joined := header + "\n\n" + strings.Join(replies, "\n\n")
	runes := []rune(joined)
	if len(runes) <= maxReplyRunes {
		return joined
	}
	return string(runes[:maxReplyRunes]) + "\n\n（分段回复过长，已截断；画布工具执行结果不受影响。）"
}

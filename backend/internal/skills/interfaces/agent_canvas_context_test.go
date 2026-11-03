package interfaces

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// Protect both run entry points: the full request canvas may seed server-side
// tools, but must never be eagerly serialized into the model prompt again.
func TestAgentRunHandlersUseOnDemandCanvasTools(t *testing.T) {
	for _, name := range []string{"agent_run_handler.go", "agent_job_handler.go"} {
		t.Run(name, func(t *testing.T) {
			file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			canvasTools, planTool, mediaTools := false, false, false
			ast.Inspect(file, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				selector, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				switch selector.Sel.Name {
				case "BuildCanvasOverview":
					t.Error("canvas summary must not be automatically injected")
				case "BuildCanvasTools":
					canvasTools = true
				case "BuildTaskProgressTool":
					planTool = true
				case "BuildAgentMediaTools":
					mediaTools = true
					// Analyze using this run's selected model and resolved endpoints,
					// never independently resolve a fallback vision provider.
					if len(call.Args) != 5 {
						t.Error("unexpected media tool registration")
					} else {
						for index, want := range map[int]string{2: "endpoints", 3: "catalogModel"} {
							arg, ok := call.Args[index].(*ast.Ident)
							if !ok || arg.Name != want {
								t.Errorf("media argument %d must reuse %s", index, want)
							}
						}
					}
				}
				return true
			})
			if !canvasTools || !planTool || !mediaTools {
				t.Fatalf("missing on-demand, progress or media tool: canvas=%v plan=%v media=%v", canvasTools, planTool, mediaTools)
			}
		})
	}
}

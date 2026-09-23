package application

import "strings"

func IsSeedreamImageModel(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(model, "seedream") || strings.Contains(model, "doubao-image")
}

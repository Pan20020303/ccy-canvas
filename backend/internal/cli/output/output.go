// Package output renders CLI results either as aligned tables / key-value
// summaries (human) or as pretty JSON (--json, for scripting).
package output

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
)

// JSON prints v as indented JSON to stdout.
func JSON(v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(b))
	return nil
}

// Table prints an aligned table with a header row.
func Table(headers []string, rows [][]string) {
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, strings.Join(headers, "\t"))
	for _, row := range rows {
		fmt.Fprintln(tw, strings.Join(row, "\t"))
	}
	_ = tw.Flush()
}

// KeyVals prints aligned key/value pairs.
func KeyVals(pairs [][2]string) {
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	for _, p := range pairs {
		fmt.Fprintf(tw, "%s\t%s\n", p[0], p[1])
	}
	_ = tw.Flush()
}

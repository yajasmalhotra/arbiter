package local

import (
	"embed"
	"encoding/json"
	"fmt"
)

//go:embed policy/core/*.rego policy/domain/*.rego policy/data/config.json
var policyFS embed.FS

type policyModule struct {
	filename string
	source   string
}

func defaultPolicyModules() ([]policyModule, error) {
	files := []string{
		"policy/core/authz.rego",
		"policy/domain/sql.rego",
		"policy/domain/slack.rego",
		"policy/domain/stripe.rego",
		"policy/domain/filesystem.rego",
	}
	modules := make([]policyModule, 0, len(files))
	for _, name := range files {
		raw, err := policyFS.ReadFile(name)
		if err != nil {
			return nil, fmt.Errorf("read embedded policy module %s: %w", name, err)
		}
		modules = append(modules, policyModule{filename: name, source: string(raw)})
	}
	return modules, nil
}

func defaultPolicyData() (map[string]any, error) {
	raw, err := policyFS.ReadFile("policy/data/config.json")
	if err != nil {
		return nil, fmt.Errorf("read embedded policy data: %w", err)
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, fmt.Errorf("decode embedded policy data: %w", err)
	}
	return data, nil
}

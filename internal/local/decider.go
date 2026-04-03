package local

import (
	"context"
	"encoding/json"
	"fmt"

	"arbiter/internal/pdp"
	"arbiter/internal/schema"

	"github.com/open-policy-agent/opa/rego"
	"github.com/open-policy-agent/opa/storage/inmem"
)

type Decider struct {
	query rego.PreparedEvalQuery
}

func NewDecider(ctx context.Context) (*Decider, error) {
	modules, err := defaultPolicyModules()
	if err != nil {
		return nil, err
	}
	data, err := defaultPolicyData()
	if err != nil {
		return nil, err
	}

	options := []func(*rego.Rego){
		rego.Query("data.arbiter.authz.decision"),
		rego.Store(inmem.NewFromObject(data)),
	}
	for _, module := range modules {
		options = append(options, rego.Module(module.filename, module.source))
	}

	prepared, err := rego.New(options...).PrepareForEval(ctx)
	if err != nil {
		return nil, fmt.Errorf("prepare local policy query: %w", err)
	}

	return &Decider{query: prepared}, nil
}

func (d *Decider) Decide(ctx context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
	results, err := d.query.Eval(ctx, rego.EvalInput(req))
	if err != nil {
		return schema.Decision{}, fmt.Errorf("evaluate local policy: %w", err)
	}
	if len(results) == 0 || len(results[0].Expressions) == 0 {
		return schema.Decision{}, fmt.Errorf("local policy returned no decision")
	}

	decision, err := decodeDecision(results[0].Expressions[0].Value)
	if err != nil {
		return schema.Decision{}, err
	}
	if decision.DecisionID == "" {
		decision.DecisionID = req.Metadata.RequestID
	}
	if !decision.Allow {
		return decision, pdp.ErrDeniedByPolicy
	}
	return decision, nil
}

func (d *Decider) Ready(_ context.Context) error {
	return nil
}

func decodeDecision(value any) (schema.Decision, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return schema.Decision{}, fmt.Errorf("encode local policy decision: %w", err)
	}
	var decision schema.Decision
	if err := json.Unmarshal(raw, &decision); err != nil {
		return schema.Decision{}, fmt.Errorf("decode local policy decision: %w", err)
	}
	return decision, nil
}

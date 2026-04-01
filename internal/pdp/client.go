package pdp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"arbiter/internal/schema"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

var ErrDeniedByPolicy = errors.New("denied by policy")

type Decider interface {
	Decide(ctx context.Context, req schema.CanonicalRequest) (schema.Decision, error)
}

type Client struct {
	httpClient *http.Client
	endpoint   string
	path       string
}

type responseEnvelope struct {
	Result schema.Decision `json:"result"`
}

func NewClient(endpoint, path string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	if path == "" {
		path = "/v1/data/arbiter/authz/decision"
	}

	return &Client{
		httpClient: &http.Client{Timeout: timeout},
		endpoint:   strings.TrimRight(endpoint, "/"),
		path:       path,
	}
}

func (c *Client) Decide(ctx context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
	ctx, span := otel.Tracer("arbiter/pdp").Start(ctx, "pdp.decide")
	span.SetAttributes(
		attribute.String("tool_name", req.ToolName),
		attribute.String("tenant_id", req.Metadata.TenantID),
		attribute.String("request_id", req.Metadata.RequestID),
	)
	defer span.End()

	body, err := json.Marshal(map[string]any{"input": req})
	if err != nil {
		span.RecordError(err)
		return schema.Decision{}, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+c.path, bytes.NewReader(body))
	if err != nil {
		span.RecordError(err)
		return schema.Decision{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		span.RecordError(err)
		return schema.Decision{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		err := fmt.Errorf("opa status %d", resp.StatusCode)
		span.RecordError(err)
		return schema.Decision{}, err
	}

	var envelope responseEnvelope
	decoder := json.NewDecoder(resp.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		span.RecordError(err)
		return schema.Decision{}, err
	}

	if envelope.Result.DecisionID == "" {
		envelope.Result.DecisionID = req.Metadata.RequestID
	}
	if !envelope.Result.Allow {
		span.RecordError(ErrDeniedByPolicy)
		return envelope.Result, ErrDeniedByPolicy
	}

	return envelope.Result, nil
}

func (c *Client) Ready(ctx context.Context) error {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint+"/health", nil)
	if err != nil {
		return err
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("opa health status %d", resp.StatusCode)
	}
	return nil
}

type StaticDecider struct {
	Decision schema.Decision
	Err      error
}

func (s StaticDecider) Decide(_ context.Context, _ schema.CanonicalRequest) (schema.Decision, error) {
	return s.Decision, s.Err
}

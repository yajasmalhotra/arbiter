package audit

import (
	"context"
	"log/slog"
	"time"
)

type Event struct {
	DecisionID    string
	RequestID     string
	TraceID       string
	TenantID      string
	ToolName      string
	Allow         bool
	Reason        string
	PolicyVersion string
	Latency       time.Duration
}

type Recorder interface {
	Record(ctx context.Context, event Event)
}

type LogRecorder struct {
	logger *slog.Logger
}

func NewLogRecorder(logger *slog.Logger) *LogRecorder {
	return &LogRecorder{logger: logger}
}

func (r *LogRecorder) Record(_ context.Context, event Event) {
	if r == nil || r.logger == nil {
		return
	}

	r.logger.Info("arbiter decision",
		slog.String("decision_id", event.DecisionID),
		slog.String("request_id", event.RequestID),
		slog.String("trace_id", event.TraceID),
		slog.String("tenant_id", event.TenantID),
		slog.String("tool_name", event.ToolName),
		slog.Bool("allow", event.Allow),
		slog.String("reason", event.Reason),
		slog.String("policy_version", event.PolicyVersion),
		slog.Duration("latency", event.Latency),
	)
}

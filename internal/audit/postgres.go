package audit

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	defaultPostgresQueueSize = 1024
	defaultPersistTimeout    = 2 * time.Second
)

type PostgresRecorder struct {
	logger *slog.Logger
	pool   *pgxpool.Pool
	queue  chan Event
	done   chan struct{}
	closed atomic.Bool
}

func NewPostgresRecorder(ctx context.Context, dsn string, queueSize int, logger *slog.Logger) (*PostgresRecorder, error) {
	if queueSize <= 0 {
		queueSize = defaultPostgresQueueSize
	}

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}

	recorder := &PostgresRecorder{
		logger: logger,
		pool:   pool,
		queue:  make(chan Event, queueSize),
		done:   make(chan struct{}),
	}

	if err := recorder.ensureSchema(ctx); err != nil {
		pool.Close()
		return nil, err
	}

	go recorder.run()
	return recorder, nil
}

func (r *PostgresRecorder) ensureSchema(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return nil
	}

	if _, err := r.pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS audit_events (
			id TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL DEFAULT 'default',
			action TEXT NOT NULL,
			actor TEXT NOT NULL,
			policy_id TEXT,
			at TIMESTAMPTZ NOT NULL,
			metadata JSONB
		)
	`); err != nil {
		return err
	}

	if _, err := r.pool.Exec(ctx, `
		CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_time
		ON audit_events(tenant_id, at DESC)
	`); err != nil {
		return err
	}

	return nil
}

func (r *PostgresRecorder) Record(_ context.Context, event Event) {
	if r == nil || r.closed.Load() {
		return
	}

	select {
	case r.queue <- event:
	default:
		if r.logger != nil {
			r.logger.Warn("dropping audit event because postgres queue is full")
		}
	}
}

func (r *PostgresRecorder) run() {
	defer close(r.done)

	for event := range r.queue {
		ctx, cancel := context.WithTimeout(context.Background(), defaultPersistTimeout)
		err := r.persist(ctx, event)
		cancel()
		if err != nil && r.logger != nil {
			r.logger.Error("failed to persist audit event", "error", err)
		}
	}
}

func (r *PostgresRecorder) persist(ctx context.Context, event Event) error {
	if r == nil || r.pool == nil {
		return nil
	}

	tenantID := strings.TrimSpace(event.TenantID)
	if tenantID == "" {
		tenantID = "default"
	}

	at := time.Now().UTC()
	if event.Latency > 0 {
		at = at.Add(-event.Latency)
	}

	metadata := map[string]any{
		"decision_id":    event.DecisionID,
		"request_id":     event.RequestID,
		"trace_id":       event.TraceID,
		"tool_name":      event.ToolName,
		"allow":          event.Allow,
		"reason":         event.Reason,
		"policy_version": event.PolicyVersion,
		"latency_ms":     float64(event.Latency) / float64(time.Millisecond),
	}
	raw, err := json.Marshal(metadata)
	if err != nil {
		return err
	}

	_, err = r.pool.Exec(ctx, `
		INSERT INTO audit_events (id, tenant_id, action, actor, policy_id, at, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
	`,
		uuid.NewString(),
		tenantID,
		"intercept_decision",
		"arbiter-interceptor",
		nil,
		at,
		string(raw),
	)
	return err
}

func (r *PostgresRecorder) Close(ctx context.Context) error {
	if r == nil || r.closed.Swap(true) {
		return nil
	}

	close(r.queue)
	select {
	case <-r.done:
	case <-ctx.Done():
		return ctx.Err()
	}

	if r.pool != nil {
		r.pool.Close()
	}
	return nil
}

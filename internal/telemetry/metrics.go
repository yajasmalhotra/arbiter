package telemetry

import (
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

type Recorder interface {
	ObserveDecision(toolName string, allow bool, latency time.Duration)
}

type NopRecorder struct{}

func (NopRecorder) ObserveDecision(string, bool, time.Duration) {}

type CounterRecorder struct {
	decisionsTotal    atomic.Uint64
	decisionsAllow    atomic.Uint64
	decisionsDeny     atomic.Uint64
	latencyNanosTotal atomic.Uint64
	perTool           sync.Map
}

type toolCounters struct {
	allow atomic.Uint64
	deny  atomic.Uint64
}

type Snapshot struct {
	DecisionsTotal    uint64
	DecisionsAllow    uint64
	DecisionsDeny     uint64
	LatencyNanosTotal uint64
	ToolBreakdown     map[string]ToolSnapshot
}

type ToolSnapshot struct {
	Allow uint64
	Deny  uint64
}

func NewCounterRecorder() *CounterRecorder {
	return &CounterRecorder{}
}

func (r *CounterRecorder) ObserveDecision(toolName string, allow bool, latency time.Duration) {
	r.decisionsTotal.Add(1)
	if allow {
		r.decisionsAllow.Add(1)
	} else {
		r.decisionsDeny.Add(1)
	}

	if latency > 0 {
		r.latencyNanosTotal.Add(uint64(latency.Nanoseconds()))
	}

	if toolName == "" {
		return
	}

	value, _ := r.perTool.LoadOrStore(toolName, &toolCounters{})
	counters := value.(*toolCounters)
	if allow {
		counters.allow.Add(1)
		return
	}
	counters.deny.Add(1)
}

func (r *CounterRecorder) Snapshot() Snapshot {
	snapshot := Snapshot{
		DecisionsTotal:    r.decisionsTotal.Load(),
		DecisionsAllow:    r.decisionsAllow.Load(),
		DecisionsDeny:     r.decisionsDeny.Load(),
		LatencyNanosTotal: r.latencyNanosTotal.Load(),
		ToolBreakdown:     make(map[string]ToolSnapshot),
	}

	r.perTool.Range(func(key, value any) bool {
		toolName := key.(string)
		counters := value.(*toolCounters)
		snapshot.ToolBreakdown[toolName] = ToolSnapshot{
			Allow: counters.allow.Load(),
			Deny:  counters.deny.Load(),
		}
		return true
	})
	return snapshot
}

func (r *CounterRecorder) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		snapshot := r.Snapshot()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")

		_, _ = fmt.Fprintf(w, "arbiter_decisions_total %d\n", snapshot.DecisionsTotal)
		_, _ = fmt.Fprintf(w, "arbiter_decisions_allow_total %d\n", snapshot.DecisionsAllow)
		_, _ = fmt.Fprintf(w, "arbiter_decisions_deny_total %d\n", snapshot.DecisionsDeny)
		_, _ = fmt.Fprintf(w, "arbiter_decision_latency_nanos_total %d\n", snapshot.LatencyNanosTotal)

		for toolName, counters := range snapshot.ToolBreakdown {
			_, _ = fmt.Fprintf(w, "arbiter_tool_decisions_allow_total{tool_name=%q} %d\n", toolName, counters.Allow)
			_, _ = fmt.Fprintf(w, "arbiter_tool_decisions_deny_total{tool_name=%q} %d\n", toolName, counters.Deny)
		}
	}
}

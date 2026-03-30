package telemetry

import (
	"fmt"
	"math"
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
	histogram         latencyHistogram
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
	LatencyBuckets    map[float64]uint64
	ToolBreakdown     map[string]ToolSnapshot
}

type ToolSnapshot struct {
	Allow uint64
	Deny  uint64
}

func NewCounterRecorder() *CounterRecorder {
	return &CounterRecorder{
		histogram: newLatencyHistogram([]float64{
			float64(1 * time.Millisecond),
			float64(5 * time.Millisecond),
			float64(10 * time.Millisecond),
			float64(20 * time.Millisecond),
			float64(30 * time.Millisecond),
			float64(50 * time.Millisecond),
			float64(100 * time.Millisecond),
			float64(250 * time.Millisecond),
			float64(500 * time.Millisecond),
			float64(time.Second),
		}),
	}
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
		r.histogram.Observe(float64(latency))
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
		LatencyBuckets:    r.histogram.Snapshot(),
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
		for upperBound, count := range snapshot.LatencyBuckets {
			label := fmt.Sprintf("%g", upperBound)
			if math.IsInf(upperBound, 1) {
				label = "+Inf"
			}
			_, _ = fmt.Fprintf(w, "arbiter_decision_latency_bucket{le=%q} %d\n", label, count)
		}

		for toolName, counters := range snapshot.ToolBreakdown {
			_, _ = fmt.Fprintf(w, "arbiter_tool_decisions_allow_total{tool_name=%q} %d\n", toolName, counters.Allow)
			_, _ = fmt.Fprintf(w, "arbiter_tool_decisions_deny_total{tool_name=%q} %d\n", toolName, counters.Deny)
		}
	}
}

type latencyHistogram struct {
	upperBounds []float64
	mu          sync.RWMutex
	counts      []uint64
}

func newLatencyHistogram(upperBounds []float64) latencyHistogram {
	bounds := append([]float64(nil), upperBounds...)
	bounds = append(bounds, math.Inf(1))
	return latencyHistogram{
		upperBounds: bounds,
		counts:      make([]uint64, len(bounds)),
	}
}

func (h *latencyHistogram) Observe(value float64) {
	h.mu.Lock()
	defer h.mu.Unlock()

	for i, bound := range h.upperBounds {
		if value <= bound {
			h.counts[i]++
		}
	}
}

func (h *latencyHistogram) Snapshot() map[float64]uint64 {
	h.mu.RLock()
	defer h.mu.RUnlock()

	values := make(map[float64]uint64, len(h.upperBounds))
	for i, bound := range h.upperBounds {
		values[bound] = h.counts[i]
	}
	return values
}

package telemetry

import "time"

type Recorder interface {
	ObserveDecision(toolName string, allow bool, latency time.Duration)
}

type NopRecorder struct{}

func (NopRecorder) ObserveDecision(string, bool, time.Duration) {}

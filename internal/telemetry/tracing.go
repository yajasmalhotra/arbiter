package telemetry

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
)

const HeaderTraceID = "X-Arbiter-Trace-ID"

type traceContextKey struct{}

func WithTrace(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		traceID := r.Header.Get(HeaderTraceID)
		if traceID == "" {
			traceID = generateTraceID()
		}

		ctx := context.WithValue(r.Context(), traceContextKey{}, traceID)
		w.Header().Set(HeaderTraceID, traceID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func TraceIDFromContext(ctx context.Context) string {
	traceID, _ := ctx.Value(traceContextKey{}).(string)
	return traceID
}

func generateTraceID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "trace-unavailable"
	}
	return hex.EncodeToString(b[:])
}

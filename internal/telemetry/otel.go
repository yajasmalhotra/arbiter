package telemetry

import (
	"context"
	"errors"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

type OTelConfig struct {
	Enabled     bool
	Endpoint    string
	ServiceName string
	Insecure    bool
}

func InitOTel(ctx context.Context, cfg OTelConfig) (func(context.Context) error, error) {
	if !cfg.Enabled {
		return func(context.Context) error { return nil }, nil
	}
	if cfg.Endpoint == "" {
		return nil, errors.New("otel endpoint is required when otel is enabled")
	}
	if cfg.ServiceName == "" {
		cfg.ServiceName = "arbiter"
	}

	options := []otlptracehttp.Option{
		otlptracehttp.WithEndpoint(cfg.Endpoint),
		otlptracehttp.WithTimeout(3 * time.Second),
	}
	if cfg.Insecure {
		options = append(options, otlptracehttp.WithInsecure())
	}

	exporter, err := otlptracehttp.New(ctx, options...)
	if err != nil {
		return nil, err
	}

	res, err := resource.New(ctx, resource.WithAttributes(
		semconv.ServiceName(cfg.ServiceName),
	))
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	return tp.Shutdown, nil
}

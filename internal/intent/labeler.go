package intent

import (
	"context"

	"arbiter/internal/schema"
)

type Labeler interface {
	Label(ctx context.Context, req schema.CanonicalRequest) (string, error)
}

type NopLabeler struct{}

func (NopLabeler) Label(context.Context, schema.CanonicalRequest) (string, error) {
	return "", nil
}

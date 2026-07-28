// Package delegation validates signed, attenuating agent delegation chains.
package delegation

import (
	"errors"
	"fmt"
	"strings"

	"arbiter/internal/schema"

	"github.com/golang-jwt/jwt/v5"
)

var ErrInvalidChain = errors.New("invalid delegation chain")

type Claims struct {
	ParentSubject   string `json:"parent_subject"`
	DelegateSubject string `json:"delegate_subject"`
	TenantID        string `json:"tenant_id"`
	TaskID          string `json:"task_id,omitempty"`
	GrantID         string `json:"grant_id,omitempty"`
	MayDelegate     bool   `json:"may_delegate,omitempty"`
	jwt.RegisteredClaims
}

type Verifier struct {
	Keys     map[string][]byte
	Issuer   string
	Audience string
	MaxDepth int
}

// Verify validates a chain ordered parent-to-child and requires its final
// delegate to be the authenticated principal. Each intermediate link must
// explicitly permit further delegation.
func (v Verifier) Verify(rawTokens []string, principal schema.Principal) ([]schema.DelegationLink, error) {
	if len(rawTokens) == 0 {
		return nil, nil
	}
	if v.MaxDepth <= 0 {
		v.MaxDepth = 4
	}
	if len(rawTokens) > v.MaxDepth || len(v.Keys) == 0 || v.Issuer == "" || v.Audience == "" {
		return nil, ErrInvalidChain
	}
	chain := make([]schema.DelegationLink, 0, len(rawTokens))
	previousDelegate := ""
	for index, raw := range rawTokens {
		claims, err := v.parse(strings.TrimSpace(raw))
		if err != nil || claims.TenantID != principal.TenantID || claims.ParentSubject == "" || claims.DelegateSubject == "" {
			return nil, ErrInvalidChain
		}
		if index > 0 {
			if claims.ParentSubject != previousDelegate || !chain[index-1].MayDelegate {
				return nil, ErrInvalidChain
			}
		}
		chain = append(chain, schema.DelegationLink{
			ParentSubject:   claims.ParentSubject,
			DelegateSubject: claims.DelegateSubject,
			TaskID:          claims.TaskID,
			GrantID:         claims.GrantID,
			MayDelegate:     claims.MayDelegate,
		})
		previousDelegate = claims.DelegateSubject
	}
	if previousDelegate != principal.Subject {
		return nil, fmt.Errorf("%w: final delegate does not match principal", ErrInvalidChain)
	}
	return chain, nil
}

func (v Verifier) parse(raw string) (*Claims, error) {
	if raw == "" {
		return nil, ErrInvalidChain
	}
	parsed, err := jwt.ParseWithClaims(raw, &Claims{}, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidChain
		}
		keyID, _ := token.Header["kid"].(string)
		secret, ok := v.Keys[keyID]
		if !ok || keyID == "" {
			return nil, ErrInvalidChain
		}
		return secret, nil
	}, jwt.WithIssuer(v.Issuer), jwt.WithAudience(v.Audience))
	if err != nil || !parsed.Valid {
		return nil, ErrInvalidChain
	}
	claims, ok := parsed.Claims.(*Claims)
	if !ok {
		return nil, ErrInvalidChain
	}
	return claims, nil
}

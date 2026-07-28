// Package approval issues and validates short-lived, action-bound human
// approval receipts. A receipt is not a general authorization grant: it can
// only satisfy the exact canonical action hash it was approved for.
package approval

import (
	"context"
	"errors"
	"strings"
	"time"

	"arbiter/internal/schema"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

var ErrInvalidReceipt = errors.New("invalid approval receipt")

type Claims struct {
	ApprovalID string `json:"approval_id"`
	ActionHash string `json:"action_hash"`
	TenantID   string `json:"tenant_id"`
	Subject    string `json:"subject"`
	Class      string `json:"class,omitempty"`
	ApprovedBy string `json:"approved_by"`
	jwt.RegisteredClaims
}

type IssuerVerifier struct {
	Keys        map[string][]byte
	ActiveKeyID string
	Issuer      string
	Audience    string
	TTL         time.Duration
}

func NewIssuerVerifier(keys map[string][]byte, activeKeyID, issuer, audience string, ttl time.Duration) *IssuerVerifier {
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	if activeKeyID == "" {
		activeKeyID = "default"
	}
	if issuer == "" {
		issuer = "arbiter"
	}
	if audience == "" {
		audience = "arbiter-approval"
	}
	return &IssuerVerifier{Keys: keys, ActiveKeyID: activeKeyID, Issuer: issuer, Audience: audience, TTL: ttl}
}

func (i *IssuerVerifier) Issue(req schema.CanonicalRequest, principal schema.Principal, approvedBy, class string) (string, error) {
	if i == nil || len(i.Keys) == 0 || strings.TrimSpace(approvedBy) == "" {
		return "", ErrInvalidReceipt
	}
	secret := i.Keys[i.ActiveKeyID]
	if len(secret) == 0 {
		return "", ErrInvalidReceipt
	}
	actionHash, err := req.ActionHash()
	if err != nil {
		return "", err
	}
	now := time.Now()
	claims := Claims{ApprovalID: uuid.NewString(), ActionHash: actionHash, TenantID: principal.TenantID, Subject: principal.Subject, Class: class, ApprovedBy: approvedBy,
		RegisteredClaims: jwt.RegisteredClaims{Issuer: i.Issuer, Audience: jwt.ClaimStrings{i.Audience}, IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(i.TTL)), ID: uuid.NewString()}}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	token.Header["kid"] = i.ActiveKeyID
	return token.SignedString(secret)
}

func (i *IssuerVerifier) Verify(_ context.Context, raw string, req schema.CanonicalRequest, principal schema.Principal) (schema.Approval, error) {
	if i == nil || strings.TrimSpace(raw) == "" || len(i.Keys) == 0 {
		return schema.Approval{}, ErrInvalidReceipt
	}
	parsed, err := jwt.ParseWithClaims(raw, &Claims{}, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidReceipt
		}
		kid, _ := token.Header["kid"].(string)
		key, ok := i.Keys[kid]
		if !ok || kid == "" {
			return nil, ErrInvalidReceipt
		}
		return key, nil
	}, jwt.WithIssuer(i.Issuer), jwt.WithAudience(i.Audience))
	if err != nil || !parsed.Valid {
		return schema.Approval{}, ErrInvalidReceipt
	}
	claims, ok := parsed.Claims.(*Claims)
	if !ok || claims.ApprovalID == "" || claims.ApprovedBy == "" || claims.TenantID != principal.TenantID || claims.Subject != principal.Subject {
		return schema.Approval{}, ErrInvalidReceipt
	}
	actionHash, err := req.ActionHash()
	if err != nil || actionHash != claims.ActionHash {
		return schema.Approval{}, ErrInvalidReceipt
	}
	return schema.Approval{ApprovalID: claims.ApprovalID, ActionHash: claims.ActionHash, Class: claims.Class, ApprovedBy: claims.ApprovedBy}, nil
}

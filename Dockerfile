FROM golang:1.25.6 AS build

WORKDIR /src

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/arbiter ./cmd/interceptor

FROM gcr.io/distroless/static-debian12

COPY --from=build /out/arbiter /arbiter

EXPOSE 8080

ENTRYPOINT ["/arbiter"]

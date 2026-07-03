# syntax=docker/dockerfile:1
# Hosty telemetry backend image. Framework-dependent (IL) multi-stage build: publish with the SDK,
# run on the aspnet runtime. Portable output + the SQLitePCLRaw bundle's per-RID native libs make one
# image work on linux/amd64 and linux/arm64. See docs/features/observability-phase-2-backend.md.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS builder
WORKDIR /repo

# Restore against just the project + shared build props for a cacheable layer.
COPY global.json Directory.Build.props ./
COPY apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Haas.Hosty.TelemetryBackend.csproj apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/
RUN dotnet restore apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Haas.Hosty.TelemetryBackend.csproj

COPY apps/telemetry-backend apps/telemetry-backend
RUN dotnet publish apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Haas.Hosty.TelemetryBackend.csproj \
    -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runner
WORKDIR /app
ENV HOSTY_TELEMETRY_QUERY_PORT=8080
COPY --from=builder /app ./
EXPOSE 8080
ENTRYPOINT ["dotnet", "hosty-telemetry-backend.dll"]

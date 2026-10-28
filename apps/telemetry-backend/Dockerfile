# syntax=docker/dockerfile:1
# Hosty telemetry backend image. Framework-dependent (IL) multi-stage build: publish with the SDK,
# run on the aspnet runtime. Portable output + the SQLitePCLRaw bundle's per-RID native libs make one
# image work on linux/amd64 and linux/arm64. See docs/features/observability/feature.md.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS builder
WORKDIR /repo

# Restore against just the project + shared build props for a cacheable layer.
COPY global.json Directory.Build.props ./
COPY apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Haas.Hosty.TelemetryBackend.csproj apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/
COPY packages/app-sdk-dotnet/HostySdk.App/HostySdk.App.csproj packages/app-sdk-dotnet/HostySdk.App/
RUN dotnet restore apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Haas.Hosty.TelemetryBackend.csproj

COPY apps/telemetry-backend apps/telemetry-backend
COPY packages/app-sdk-dotnet/HostySdk.App packages/app-sdk-dotnet/HostySdk.App
COPY apps/core/src/Haas.Hosty.Core/SharedTaskContract.cs apps/core/src/Haas.Hosty.Core/SharedTaskContract.cs
RUN dotnet publish apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Haas.Hosty.TelemetryBackend.csproj \
    -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runner
WORKDIR /app
ENV HOSTY_TELEMETRY_QUERY_PORT=8080
COPY --from=builder /app ./
EXPOSE 8080
ENTRYPOINT ["dotnet", "hosty-telemetry-backend.dll"]

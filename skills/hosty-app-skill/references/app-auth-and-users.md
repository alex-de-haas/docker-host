# App Auth And Users

Runtime apps should use Core-owned app auth and app-local sessions.

## App Session Flow

1. Core creates an app open link with a short-lived authorization code.
2. Shell opens the app origin with the code.
3. The app exchanges the code through `/api/auth/apps/token`.
4. The app stores the returned app identity token in an app-origin HttpOnly cookie.
5. The app revalidates through `/api/auth/apps/revalidate`.

## Direct Probes

```bash
TOKEN="$(hosty apps identity com.haas.demo-app --user user@docker-host.local --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" http://127.0.0.1:3100/api/auth/identity
```

## Scoped App Directory

Runtime apps that need assigned Host users can call:

```text
GET /api/internal/apps/{appId}/directory/users
Authorization: Bearer <HOSTY_APP_SERVICE_TOKEN>
```

The directory is scoped to enabled users explicitly assigned to the app.

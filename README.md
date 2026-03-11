# Docker Host Manager

Next.js UI for listing, creating, updating, and removing local Docker containers.

## Local development

Run the app directly on the host:

```bash
npm install
npm run dev
```

The server connects to Docker using:

1. `DOCKER_SOCKET_PATH`, if set
2. `DOCKER_HOST`, if set
3. `/var/run/docker.sock`, by default

Examples:

```bash
DOCKER_SOCKET_PATH=/var/run/docker.sock npm run dev
DOCKER_HOST=unix:///var/run/docker.sock npm run dev
DOCKER_HOST=tcp://127.0.0.1:2375 npm run dev
```

## Running in Docker Desktop

If the app itself runs in a container, the container does not automatically get access to the host Docker socket. Mount it explicitly:

```bash
docker run --rm -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  docker-host
```

If you expose Docker over TCP instead, pass `DOCKER_HOST`:

```bash
docker run --rm -p 3000:3000 \
  -e DOCKER_HOST=tcp://host.docker.internal:2375 \
  docker-host
```

Notes:

- `host.docker.internal:2375` only works if Docker Desktop is configured to expose the daemon over TCP.
- Mounting `/var/run/docker.sock` is the usual Docker Desktop setup for containerized tools like this.
- With the socket or `DOCKER_HOST` configured, the app can also update its own container image. The UI will be briefly unavailable while the new container takes over.

## Build image

```bash
docker build -t docker-host .
```

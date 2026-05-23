# dockfe

A minimal bookmark dashboard for the container frontends running on a Docker host.

dockfe queries the local Docker daemon, figures out which running containers have a reachable web endpoint, and renders them as a quiet grid of links — grouped by Docker Compose project, with a search box for hosts that run hundreds of services.

## Quick start

```sh
docker compose up -d --build
```

Then open <http://localhost:3737>.

The compose file mounts `/var/run/docker.sock` read-only so dockfe can list containers without write access to the daemon.

## How it discovers services

For each running container, dockfe looks for an endpoint in this order and uses the first one that matches:

| Source | What it reads | Scheme |
| --- | --- | --- |
| Traefik | `traefik.http.routers.*.rule` (`Host(\`…\`)`) | `https` if `tls=true` or the router's entrypoints include `websecure` / `https` / `443`, else `http` |
| Caddy (caddy-docker-proxy) | `caddy` label | `https` |
| nginx-proxy | `VIRTUAL_HOST` | `https` if `LETSENCRYPT_HOST` is set or `VIRTUAL_PROTO=https`, else `VIRTUAL_PROTO` or `http` |
| Published port | `docker inspect` `NetworkSettings.Ports` | `https` for `:443` / `:8443`, else `http` |

A container with `traefik.enable=false` is skipped. Containers with no matching endpoint don't appear.

Compose service and project labels (`com.docker.compose.service`, `com.docker.compose.project`) are used to label and group cards.

Icons are pulled from [selfh.st/icons](https://github.com/selfhst/icons) and fall back to [dashboard-icons](https://github.com/walkxcode/dashboard-icons), then to the first two letters of the service name.

For each container, dockfe generates a list of candidate slugs and tries each one against both catalogs in order:

1. The image-derived slug — `ghcr.io/immich-app/immich-server:release` → `immich-server`.
2. The slug with common suffixes stripped — `immich-server` → `immich`, `portainer-ce` → `portainer`. Stripped suffixes: `-server`, `-ce`, `-ee`, `-app`, `-web`, `-ui`, `-api`, `-frontend`, `-backend`, `-core`, `-service`.
3. The compose service name (`com.docker.compose.service`) and the same suffix-stripped variants of it.
4. The compose project name (`com.docker.compose.project`).

To override the icon on a per-container basis, set the `dockfe.icon` label:

```yaml
services:
  myapp:
    image: ghcr.io/example/some-fork
    labels:
      # Use a slug from selfh.st/icons or dashboard-icons:
      dockfe.icon: adguard-home
      # Or supply a full URL:
      # dockfe.icon: https://example.com/logo.svg
```

A bare slug is resolved against the same two catalogs in the same order; a value starting with `http://`, `https://`, or `data:` is used as-is.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3737` | Port dockfe listens on inside the container |

The container's URL host (e.g. `localhost`, the host's LAN IP) is taken from the browser's address bar, so port-based links automatically resolve to whatever you reach dockfe at.

## Local development

```sh
node server.js
```

No dependencies. Requires Node 18+ and the `docker` CLI on `PATH`.

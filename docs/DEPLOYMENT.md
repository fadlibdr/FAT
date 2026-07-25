# Deploying FAT to a VPS

FAT is a pnpm/Turbo monorepo with three deployable pieces:

| Piece            | What it is            | Port   | Run command                          |
|------------------|-----------------------|--------|--------------------------------------|
| `apps/backend`   | NestJS REST/GraphQL API | `3001` | `node dist/main.js`                  |
| `apps/frontend`  | Next.js UI            | `3000` | `next start`                         |
| PostgreSQL 16    | the only hard dependency | `5432` | Docker or native                  |
| Redis 7          | **optional** (BullMQ jobs) | `6379` | only if `REDIS_HOST` is set       |

You expose **one** domain; nginx routes `/api` → backend and everything else →
frontend, with HTTPS terminated at nginx.

Two supported paths follow. **Path A (Docker Compose)** is the most reproducible
and is recommended. **Path B (Node + systemd)** runs the processes directly on the
host. Pick one.

Requirements either way: a Linux VPS (2 GB RAM minimum, 4 GB comfortable), a
domain name pointed at the VPS IP (an `A` record), and ports 80/443 open.

---

## Path A — Docker Compose (recommended)

Files used: `docker-compose.prod.yml`, `apps/backend/Dockerfile`,
`apps/frontend/Dockerfile`, `.env.production.example`, `deploy/nginx.conf`.

### 1. Install Docker and nginx on the VPS
```bash
curl -fsSL https://get.docker.com | sh
sudo apt-get install -y nginx
```

### 2. Get the code
```bash
sudo mkdir -p /opt/fat && sudo chown "$USER" /opt/fat
git clone <your-repo-url> /opt/fat
cd /opt/fat
```

### 3. Create the production env file
```bash
cp .env.production.example .env.production
```
Edit `.env.production` and set, at minimum:
- `DATABASE_PASSWORD` — a strong password
- `JWT_SECRET` — `openssl rand -hex 32`
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — your real admin login
- `NEXT_PUBLIC_API_URL=https://yourdomain.com/api` — **must be the public URL**
- keep `DATABASE_HOST=postgres` (the compose service name)

### 4. Build and start the stack
```bash
docker compose -f docker-compose.prod.yml up -d --build
```
The API container runs schema migrations automatically on start (they are
additive and safe to repeat). Watch it come up:
```bash
docker compose -f docker-compose.prod.yml logs -f api
```
Wait for `FAT backend listening on :3001`.

> Enabling Redis/background jobs: set `REDIS_HOST=redis` in `.env.production`,
> then start with `--profile redis`:
> `docker compose -f docker-compose.prod.yml --profile redis up -d --build`.

### 5. Seed the admin + demo data (once only)
```bash
docker compose -f docker-compose.prod.yml run --rm api pnpm backend:seed
```
Run this **exactly once** on a fresh database — it creates the admin user and
sample records. Re-running it on a live DB will error or duplicate.

### 6. Put nginx in front (+ HTTPS)
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/fat
sudo sed -i 's/yourdomain.com/REALDOMAIN/g' /etc/nginx/sites-available/fat
sudo ln -sf /etc/nginx/sites-available/fat /etc/nginx/sites-enabled/fat
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# TLS certificate (auto-renewing):
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d REALDOMAIN
```
Visit `https://REALDOMAIN` and log in with the admin credentials from step 3.

### Updating to a new version
```bash
cd /opt/fat && git pull
docker compose -f docker-compose.prod.yml up -d --build
```
Migrations re-run on API start. If you changed `NEXT_PUBLIC_API_URL`, the `--build`
rebuilds the web image with the new value. **Do not** re-run the seed.

---

## Path B — Node + systemd (no Docker for the app)

Runs the built apps directly with Node, managed by systemd. Postgres can still be
a Docker container (simplest) or a native install.

### 1. Install Node 22, pnpm, nginx
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
sudo npm install -g pnpm@9
```

### 2. Postgres (Docker is easiest)
```bash
curl -fsSL https://get.docker.com | sh
cd /opt/fat && docker compose up -d postgres      # uses the dev docker-compose.yml
```
(Or install `postgresql-16` natively and create the `fat` role/database to match
your `.env`.)

### 3. Code, env, install, build
```bash
sudo mkdir -p /opt/fat && sudo chown "$USER" /opt/fat
git clone <your-repo-url> /opt/fat && cd /opt/fat

cp .env.production.example .env          # root .env is auto-loaded by the app
# edit .env: set DATABASE_HOST=localhost, JWT_SECRET, ADMIN_*, and
# NEXT_PUBLIC_API_URL=https://yourdomain.com/api

pnpm install --frozen-lockfile
pnpm build                               # builds shared + backend + frontend
```

### 4. Migrate + seed
```bash
pnpm backend:migration:run               # create schema (safe to repeat)
pnpm backend:seed                        # ONCE: admin + demo data
```

### 5. Run under systemd
```bash
sudo useradd -r -s /usr/sbin/nologin fat 2>/dev/null || true
sudo chown -R fat:fat /opt/fat
sudo cp deploy/systemd/fat-api.service deploy/systemd/fat-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fat-api fat-web
sudo systemctl status fat-api fat-web    # both should be "active (running)"
```
(`pnpm` must be on PATH for the `fat` user, or replace `ExecStart` in
`fat-web.service` with the absolute path from `which pnpm`. Prefer pm2 instead? see below.)

### 6. nginx + HTTPS
Same as Path A step 6.

### Updating
```bash
cd /opt/fat && git pull
pnpm install --frozen-lockfile && pnpm build
pnpm backend:migration:run
sudo systemctl restart fat-api fat-web
```

> **pm2 alternative to systemd** (runs as your user, no unit files):
> ```bash
> sudo npm i -g pm2
> pm2 start "node dist/main.js" --name fat-api --cwd /opt/fat/apps/backend
> pm2 start "pnpm start"        --name fat-web --cwd /opt/fat/apps/frontend
> pm2 save && pm2 startup       # follow the printed command
> ```

---

## Operational notes (read these)

- **`NEXT_PUBLIC_API_URL` is baked in at build time.** Changing it requires
  rebuilding the frontend (Docker: `--build`; Node: `pnpm --filter @fat/frontend build`).
- **Seed once.** Migrations (`init-schema.ts`) are additive and idempotent; the
  seed is not — only run it on a brand-new database.
- **Uploaded files** live in `apps/backend/data/files` (attachments, avatars,
  print assets). In Docker this is the `fat-uploads` volume. Back it up alongside
  the database.
- **Secrets.** Never commit the filled-in `.env` / `.env.production`. Rotate
  `JWT_SECRET` only during a maintenance window (it invalidates existing tokens).
- **Firewall.** Expose only 80/443 publicly; keep 3000/3001/5432/6379 bound to
  localhost (the compose file already binds api/web to `127.0.0.1`).
- **Backups.** Database:
  `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U fat fat > backup.sql`
  (or `pg_dump` directly for a native install). Store off-box.
- **Health check.** `curl -s http://127.0.0.1:3001/api/health` should return
  `{"status":"ok","db":"up"}`.
- **Sizing.** One VPS comfortably runs everything. To scale the API horizontally,
  set `REDIS_HOST` (jobs + metadata cache coherence use it) and run multiple `api`
  replicas behind nginx.

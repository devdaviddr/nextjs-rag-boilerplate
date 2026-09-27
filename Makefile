# Cloudflare Tunnel deployment helpers. See docs/deployment.md.
COMPOSE := docker compose -f docker-compose.prod.yml
DEPLOY  := docker compose -f docker-compose.prod.yml -f docker-compose.deploy.yml -f docker-compose.tunnel.yml
TF      := terraform -chdir=infra/cloudflare

.DEFAULT_GOAL := help

.PHONY: help init setup deploy deploy-timer autostart tunnel-quick tunnel-provision tunnel-token tunnel-up tunnel-down tunnel-verify tunnel-destroy

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

init: ## Rename a new project started from this template (asks for name, repo URL, colour)
	@node scripts/init-project.mjs

setup: ## Guided one-click self-hosting (secrets → tunnel → seed → verify)
	@./scripts/setup.sh

# Pull the two GHCR images one at a time rather than a single parallel
# `compose pull` — the all-services parallel pull hangs on some Podman machines,
# and pulling only app+migrate avoids re-checking the Docker Hub base images
# (postgres/minio/cloudflared) on every run (rate limits). `up -d` then recreates
# app behind the tunnel (migrate one-shot runs first via depends_on).
deploy: ## Pull the published GHCR image + migrate + restart behind the tunnel (needs APP_IMAGE)
	$(DEPLOY) pull app
	$(DEPLOY) pull migrate
	$(DEPLOY) up -d

deploy-timer: ## macOS: install a launchd timer that runs `make deploy` on an interval (Tier B pull; default 60s, digest-skipped)
	@./scripts/macos-deploy-timer.sh install

autostart: ## macOS: install a login LaunchAgent that boots the stack after a reboot
	@./scripts/macos-autostart.sh install

tunnel-quick: ## Ephemeral public URL, no account (prints the trycloudflare.com URL)
	$(COMPOSE) -f docker-compose.quick-tunnel.yml up --build

tunnel-provision: ## Provision tunnel + DNS via Terraform, write token to .env
	$(TF) init -input=false
	$(TF) apply -auto-approve
	@token="$$($(TF) output -raw tunnel_token)"; \
	  if grep -q '^CLOUDFLARE_TUNNEL_TOKEN=' .env 2>/dev/null; then \
	    sed -i.bak "s|^CLOUDFLARE_TUNNEL_TOKEN=.*|CLOUDFLARE_TUNNEL_TOKEN=$$token|" .env && rm -f .env.bak; \
	  else echo "CLOUDFLARE_TUNNEL_TOKEN=$$token" >> .env; fi; \
	  echo "✓ Wrote CLOUDFLARE_TUNNEL_TOKEN to .env — set AUTH_URL, then: make tunnel-up"

tunnel-token: ## Print the tunnel token from Terraform state
	@$(TF) output -raw tunnel_token

tunnel-up: ## Start the full stack behind the named tunnel
	$(COMPOSE) -f docker-compose.tunnel.yml up -d --build

tunnel-down: ## Stop the tunnel stack (keeps data)
	$(COMPOSE) -f docker-compose.tunnel.yml down

tunnel-verify: ## Health-check a deployment: URL=https://app.example.com make tunnel-verify
	./scripts/tunnel-verify.sh "$(URL)"

tunnel-destroy: ## Tear down the Cloudflare tunnel + DNS (Terraform)
	$(TF) destroy -auto-approve

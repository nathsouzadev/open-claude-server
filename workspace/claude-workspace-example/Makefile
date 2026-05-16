COMPOSE := docker compose -f docker/docker-compose.yml

.PHONY: build up down shell logs ps clean rebuild \
        server-build server-up server-down server-restart server-logs server-shell

build:
	$(COMPOSE) build

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

shell:
	$(COMPOSE) exec claude bash

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

clean:
	$(COMPOSE) down -v

rebuild:
	$(COMPOSE) build --no-cache

# --- HTTP server (claude-server container) ---

server-build:
	$(COMPOSE) build server

server-up:
	$(COMPOSE) up -d server

server-down:
	$(COMPOSE) stop server

server-restart:
	$(COMPOSE) restart server

server-logs:
	$(COMPOSE) logs -f server

server-shell:
	$(COMPOSE) exec server bash

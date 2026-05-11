FROM node:22-bookworm-slim

ARG USER_UID=501
ARG USER_GID=501
ARG USER_NAME=claude

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl bash vim jq ca-certificates openssh-client gnupg \
      python3 python3-pip python3-venv \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
      -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq

RUN npm install -g @anthropic-ai/claude-code claude-mem bun

# Pre-install server deps so the named volume `server_node_modules` is seeded
# from this layer on first boot. Server source is bind-mounted at runtime, so
# changes to src/ don't require rebuild.
COPY server/package.json server/package-lock.json* /workspace/server/
WORKDIR /workspace/server
RUN npm install --omit=dev
WORKDIR /workspace

RUN if getent group node >/dev/null; then groupdel node || true; fi \
 && if id -u node >/dev/null 2>&1; then userdel -r node 2>/dev/null || true; fi \
 && groupadd -g ${USER_GID} ${USER_NAME} \
 && useradd  -m -u ${USER_UID} -g ${USER_GID} -s /bin/bash ${USER_NAME} \
 && mkdir -p /workspace /home/${USER_NAME}/.claude /home/${USER_NAME}/.ssh \
 && chown -R ${USER_UID}:${USER_GID} /workspace /home/${USER_NAME}

COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ${USER_NAME}
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]

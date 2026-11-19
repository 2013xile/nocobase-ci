FROM node:24-bookworm

ARG BUILD_UID
ARG BUILD_GID

# HOME alone does not make os.userInfo() work for the runner's numeric UID.
# This trusted context contains no application code or package configuration.
RUN set -eu; \
    case "$BUILD_UID" in ''|*[!0-9]*) exit 1 ;; esac; \
    case "$BUILD_GID" in ''|*[!0-9]*) exit 1 ;; esac; \
    test "$BUILD_UID" -gt 0; \
    test "$BUILD_GID" -gt 0; \
    if ! getent group "$BUILD_GID" >/dev/null; then \
        groupadd --gid "$BUILD_GID" platform-build; \
    fi; \
    if user_name="$(getent passwd "$BUILD_UID")"; then \
        user_name="${user_name%%:*}"; \
        usermod --gid "$BUILD_GID" --home /tmp/platform-home --shell /usr/sbin/nologin "$user_name"; \
    else \
        useradd --uid "$BUILD_UID" --gid "$BUILD_GID" --home-dir /tmp/platform-home \
            --no-create-home --no-log-init --shell /usr/sbin/nologin platform-build; \
    fi

USER ${BUILD_UID}:${BUILD_GID}

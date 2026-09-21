# The multi-architecture digest fixes both PostgreSQL 16 and pgvector 0.8.6.
# Building on the published extension image avoids an unpinned source download
# while this project-specific image adds the existing pgBackRest integration.
ARG PGVECTOR_BASE_IMAGE=pgvector/pgvector:0.8.6-pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b
FROM ${PGVECTOR_BASE_IMAGE}

RUN apt-get update \
    && apt-get install --yes --no-install-recommends pgbackrest \
    && rm -rf /var/lib/apt/lists/*

COPY configure-pgbackrest.sh /usr/local/bin/openpbl-configure-pgbackrest
COPY postgres-entrypoint.sh /usr/local/bin/openpbl-postgres-entrypoint
COPY backup-loop.sh /usr/local/bin/openpbl-pgbackrest-backup
RUN chmod 0555 /usr/local/bin/openpbl-configure-pgbackrest \
    /usr/local/bin/openpbl-postgres-entrypoint \
    /usr/local/bin/openpbl-pgbackrest-backup

ENTRYPOINT ["/usr/local/bin/openpbl-postgres-entrypoint"]
CMD ["postgres"]

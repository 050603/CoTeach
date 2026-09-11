FROM restic/restic:0.18.0

RUN apk add --no-cache jq postgresql16-client sqlite

COPY deploy/backup/backup-runner.sh /usr/local/bin/openpbl-backup-runner
COPY deploy/backup/restore-latest.sh /usr/local/bin/openpbl-restore-latest
RUN chmod 0555 /usr/local/bin/openpbl-backup-runner /usr/local/bin/openpbl-restore-latest

ENTRYPOINT ["/usr/local/bin/openpbl-backup-runner"]

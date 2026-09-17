FROM restic/restic:0.18.0

RUN apk add --no-cache postgresql16-client

COPY deploy/backup/manual-essential-backup.sh /usr/local/bin/openpbl-manual-essential-backup
RUN chmod 0555 /usr/local/bin/openpbl-manual-essential-backup

ENTRYPOINT ["/usr/local/bin/openpbl-manual-essential-backup"]

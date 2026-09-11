Create `deploy/secrets/` on the server with mode `0700`. Create each file
below with mode `0600`; never commit that directory.

- `postgres_password.txt`: a random PostgreSQL password.
- `database_url.txt`: `postgresql://openpbl:<URL-ENCODED-PASSWORD>@postgres:5432/openpbl?connection_limit=30&pool_timeout=10`.
- `jwt_secret.txt`: at least 43 random characters.
- `provider_encryption_key.txt`: exactly 32 random bytes encoded as base64.
- `monitor_token.txt`: at least 32 random characters.
- `grafana_admin_password.txt`: a unique Grafana administrator password.
- `s3_access_key.txt` and `s3_secret_key.txt`: restricted credentials for the
  backup bucket only.
- `restic_password.txt`: a separate high-entropy password for database,
  upload, whiteboard, and generated-classroom snapshots. Keep an offline copy;
  a lost Restic password cannot be recovered from the bucket.
- `load_test_admin_token.txt`: at least 32 random characters. It is only
  accepted when the candidate environment explicitly enables the load-test
  API and Nginx allows the independent load-generator IP.

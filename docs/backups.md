# Back up and move app data

Stop the app server before taking a full backup so the database, assets, and saved dashboard configuration remain consistent. Use the same database path that you use to serve the app.

```bash
npm run localevals -- backup --db .localevals/evalforge.db --out ../local-evals-backup
```

The destination must not already exist. The portable folder includes a SQLite snapshot, imported assets, saved dashboard configuration when present, and the credential key when present. A manifest records file checksums so restore can detect missing or changed files. Copy the whole folder to transfer your app data to another machine.

The backup is not encrypted. It contains private app data and the key needed to decrypt saved API keys. Store it on a protected or encrypted drive, do not commit it, and do not share it publicly. Restrictive file modes are applied where supported; on Windows, access also depends on the destination folder's ACLs. Environment-variable credentials are not included and must be configured on the destination machine.

## Restore into a new data directory

```bash
npm run localevals -- restore ../local-evals-backup --to .localevals-restored
npm run localevals -- serve --db .localevals-restored/app.db
```

Restore validates the bundle and creates a fresh directory. It refuses to overwrite an existing directory, leaving your current app data untouched. Imported image references are relocated to the restored assets directory. External source files, model files, environment variables, and browser-local drafts are not part of the backup. Review machine-specific provider URLs and configuration file paths before starting work on another machine.

Queued dataset jobs are preserved and may start when the restored server starts. Interrupted work is not resumed from partial model output.

## Database upgrades

The app uses numbered SQL migrations recorded in `schema_migrations`. Before upgrading an existing database, it saves an adjacent SQLite recovery snapshot. Migrations run in a transaction; an unsuccessful migration is rolled back. Opening a database from a newer, unsupported schema version is rejected.

Automatic migration snapshots contain database data only, not assets or credential keys. Keep a full app backup before upgrading or moving machines. Do not replace a running database or discard its matching credential key.

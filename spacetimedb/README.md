## SpaceTimeDB module

This module mirrors interview room state from the Node signaling backend into SpaceTimeDB.

Project files:

- `spacetimedb/src/index.ts`: SpaceTimeDB TypeScript schema + reducers
- `spacetimedb/tsconfig.json`: TypeScript configuration for the module
- `spacetimedb/package.json`: module-local dependencies and `typecheck` script

The module uses the official server-side import path:

- `import { schema, table, t } from "spacetimedb/server"`

Expected environment variables for `server.js`:

- `SPACETIMEDB_ENABLED=true`
- `SPACETIMEDB_DB_NAME=<database-name>`
- `SPACETIMEDB_SERVER_URL=<optional server url>`
- `SPACETIMEDB_IDENTITY=<optional identity>`
- `SPACETIMEDB_AUTH_TOKEN=<optional token>`

Typical flow:

1. Run `npm install` inside `spacetimedb`
2. Optionally verify the module with `npm run spacetime:typecheck`
3. Build the module with `npm run spacetime:build`
4. Publish it with the `spacetime` CLI
5. Start the Node signaling server with the environment variables above so room snapshots are mirrored into the database

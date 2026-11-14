import type { Config, Logger } from '@junction26/server-common';
import type { Pool } from '@junction26/db';
import type { ObjectStore } from '@junction26/storage';

export interface Deps {
  config: Config;
  pool: Pool;
  store: ObjectStore;
  logger: Logger;
}

/**
 * Who is calling. `user` sessions come from the authoring client; `device`
 * sessions come from paired glasses and can only read the library, sync
 * releases and back up state (see docs/api.md, "Authentication").
 */
export type Principal =
  | { kind: 'user'; userId: string }
  | { kind: 'assistant'; userId: string; clientId: string; resource: string; scopes: string[] }
  | { kind: 'device'; userId: string; deviceId: string };

export type AppEnv = {
  Variables: {
    requestId: string;
    log: Logger;
    principal: Principal;
  };
};

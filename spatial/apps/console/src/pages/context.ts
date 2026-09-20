/**
 * What every page is handed. Kept deliberately small: the API client, who the
 * caller is, the deployment's configuration, and a way to move.
 */

import type { ApiClient, MemberRole, Membership } from '@m3xi/console-ui';
import type { ConsoleConfig } from '../config.js';
import type { RouteMatch } from '../router.js';

export interface PageContext {
  readonly api: ApiClient;
  readonly config: ConsoleConfig;
  readonly membership: Membership;
  readonly role: MemberRole;
  readonly route: RouteMatch;
  navigate(hash: string): void;
  /** Re-render the current route, after something changed on the server. */
  reload(): void;
}

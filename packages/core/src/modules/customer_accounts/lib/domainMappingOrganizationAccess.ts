import type { AwilixContainer } from 'awilix'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { resolveOrganizationScopeFilter } from '@open-mercato/core/modules/directory/utils/organizationScopeFilter'

export type DomainMappingOrganizationAccess = {
  accessibleOrganizationIds: string[] | null
  listOrganizationIds: string[] | null
}

export async function resolveDomainMappingOrganizationAccess(
  container: AwilixContainer,
  auth: AuthContext,
  request: Request,
): Promise<DomainMappingOrganizationAccess> {
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  return {
    accessibleOrganizationIds: Array.isArray(scope?.allowedIds) ? scope.allowedIds : null,
    listOrganizationIds: resolveOrganizationScopeFilter(scope, auth).organizationIds ?? null,
  }
}

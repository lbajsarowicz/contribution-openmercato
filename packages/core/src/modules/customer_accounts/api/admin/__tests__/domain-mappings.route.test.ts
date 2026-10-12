/** @jest-environment node */
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  DomainMapping,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'

const mockGetAuth = jest.fn()
const mockRbac = { userHasAllFeatures: jest.fn() }
const mockScope = jest.fn()

type Row = {
  id: string
  hostname: string
  tenantId: string
  organizationId: string
  status: string
  provider: string
  tlsRetryCount: number
  verifiedAt: Date | null
  lastDnsCheckAt: Date | null
  dnsFailureReason: string | null
  tlsFailureReason: string | null
  replacesDomain: { id: string } | null
  createdAt: Date
  updatedAt: Date | null
}

const store = new Map<string, Row>()
const orgs = new Map<string, { id: string; slug: string | null; tenantId: string }>()

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, raw]) => {
    const value = (row as unknown as Record<string, unknown>)[key]
    if (raw && typeof raw === 'object' && '$in' in (raw as Record<string, unknown>)) {
      return ((raw as { $in: unknown[] }).$in).includes(value)
    }
    return value === raw
  })
}

const mockEm = {
  find: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
    if (entity === DomainMapping) return Array.from(store.values()).filter((row) => matches(row, where))
    return []
  }),
  findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
    if (entity === DomainMapping) return Array.from(store.values()).find((row) => matches(row, where)) ?? null
    if (entity === Organization) return orgs.get(where.id as string) ?? null
    return null
  }),
  create: jest.fn((_entity: unknown, data: Partial<Row>) => ({
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    status: 'pending',
    tlsRetryCount: 0,
    verifiedAt: null,
    lastDnsCheckAt: null,
    dnsFailureReason: null,
    tlsFailureReason: null,
    updatedAt: null,
    ...data,
  })),
  persist: jest.fn((entity: Row) => {
    store.set(entity.id, entity)
    return { flush: async () => undefined }
  }),
  remove: jest.fn((entity: Row) => {
    store.delete(entity.id)
  }),
  flush: jest.fn(async () => undefined),
  getConnection: jest.fn(() => ({
    execute: async (_sql: string, params: unknown[]) => {
      const [organizationId, tenantId] = params as [string, string]
      const org = orgs.get(organizationId)
      return org && org.tenantId === tenantId ? [{ slug: org.slug }] : []
    },
  })),
}

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn((req: Request) => mockGetAuth(req)),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => mockContainer),
}))

jest.mock('@open-mercato/shared/lib/crud/mutation-guard', () => ({
  validateCrudMutationGuard: jest.fn(async () => null),
  runCrudMutationGuardAfterSuccess: jest.fn(async () => undefined),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn(async () => mockScope()),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/events', () => ({
  emitCustomerAccountsEvent: jest.fn(async () => undefined),
}))

import { DomainMappingService } from '@open-mercato/core/modules/customer_accounts/services/domainMappingService'
import { GET, POST, DELETE } from '@open-mercato/core/modules/customer_accounts/api/admin/domain-mappings'
import { POST as VERIFY } from '@open-mercato/core/modules/customer_accounts/api/admin/domain-mappings/[id]/verify'
import { POST as HEALTH_CHECK } from '@open-mercato/core/modules/customer_accounts/api/admin/domain-mappings/[id]/health-check'

const service = new DomainMappingService(mockEm as unknown as EntityManager)
const mockContainer = {
  resolve: jest.fn((token: string) => {
    if (token === 'rbacService') return mockRbac
    if (token === 'em') return mockEm
    if (token === 'domainMappingService') return service
    return null
  }),
}

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG_A = '22222222-2222-4222-8222-222222222222'
const ORG_B = '33333333-3333-4333-8333-333333333333'
const ADMIN = '44444444-4444-4444-8444-444444444444'
const DOMAIN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DOMAIN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function seed(id: string, organizationId: string, status = 'verified'): Row {
  const row: Row = {
    id,
    hostname: `${id.slice(0, 4)}.example.com`,
    tenantId: TENANT,
    organizationId,
    status,
    provider: 'traefik',
    tlsRetryCount: 0,
    verifiedAt: null,
    lastDnsCheckAt: null,
    dnsFailureReason: null,
    tlsFailureReason: null,
    replacesDomain: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: null,
  }
  store.set(id, row)
  return row
}

function asCallerIn(orgId: string, ids: string[] | null, filterIds: string[] | null = ids) {
  mockGetAuth.mockResolvedValue({ sub: ADMIN, tenantId: TENANT, orgId })
  mockScope.mockReturnValue({
    selectedId: filterIds && filterIds.length === 1 ? filterIds[0] : null,
    filterIds,
    allowedIds: ids,
    tenantId: TENANT,
  })
}

const url = 'http://localhost/api/customer_accounts/admin/domain-mappings'
const routeCtx = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  jest.clearAllMocks()
  store.clear()
  orgs.clear()
  orgs.set(ORG_A, { id: ORG_A, slug: null, tenantId: TENANT })
  orgs.set(ORG_B, { id: ORG_B, slug: null, tenantId: TENANT })
  mockRbac.userHasAllFeatures.mockResolvedValue(true)
  seed(DOMAIN_A, ORG_A)
  seed(DOMAIN_B, ORG_B)
})

describe('admin domain-mappings: organization boundary', () => {
  describe('GET', () => {
    it('lists only mappings of the caller organization', async () => {
      asCallerIn(ORG_B, [ORG_B])
      const body = await (await GET(new Request(url))).json()
      expect(body.domainMappings.map((m: { id: string }) => m.id)).toEqual([DOMAIN_B])
    })

    it('returns nothing when the organizationId filter is outside the accessible set', async () => {
      asCallerIn(ORG_B, [ORG_B])
      const body = await (await GET(new Request(`${url}?organizationId=${ORG_A}`))).json()
      expect(body.domainMappings).toEqual([])
    })

    it('returns nothing for a caller with an empty accessible set', async () => {
      asCallerIn(ORG_B, [])
      const body = await (await GET(new Request(url))).json()
      expect(body.domainMappings).toEqual([])
    })

    it('lets the page organization picker address an accessible organization outside the header switcher selection', async () => {
      asCallerIn(ORG_B, [ORG_A, ORG_B], [ORG_B])
      const body = await (await GET(new Request(`${url}?organizationId=${ORG_A}`))).json()
      expect(body.domainMappings.map((m: { id: string }) => m.id)).toEqual([DOMAIN_A])
    })

    it('narrows the unfiltered list to the header switcher selection', async () => {
      asCallerIn(ORG_B, [ORG_A, ORG_B], [ORG_B])
      const body = await (await GET(new Request(url))).json()
      expect(body.domainMappings.map((m: { id: string }) => m.id)).toEqual([DOMAIN_B])
    })

    it('rejects a malformed organizationId with 400', async () => {
      asCallerIn(ORG_B, [ORG_B])
      expect((await GET(new Request(`${url}?organizationId=not-a-uuid`))).status).toBe(400)
    })

    it('returns 401 when the session has no tenant', async () => {
      mockGetAuth.mockResolvedValue({ sub: ADMIN, tenantId: null, orgId: ORG_B })
      expect((await GET(new Request(url))).status).toBe(401)
    })

    it('lists every organization of the tenant for an unrestricted caller', async () => {
      asCallerIn(ORG_B, null)
      const body = await (await GET(new Request(url))).json()
      expect(body.domainMappings.map((m: { id: string }) => m.id).sort()).toEqual([DOMAIN_A, DOMAIN_B])
    })

    it('lists several accessible organizations', async () => {
      asCallerIn(ORG_B, [ORG_A, ORG_B])
      const body = await (await GET(new Request(`${url}?organizationId=${ORG_A}`))).json()
      expect(body.domainMappings.map((m: { id: string }) => m.id)).toEqual([DOMAIN_A])
    })
  })

  describe('POST', () => {
    it('rejects an organizationId outside the accessible set with 403', async () => {
      asCallerIn(ORG_B, [ORG_B])
      const res = await POST(post({ hostname: 'new.example.com', organizationId: ORG_A }))
      expect(res.status).toBe(403)
      expect(mockEm.persist).not.toHaveBeenCalled()
    })

    it('registers for an accessible organization', async () => {
      asCallerIn(ORG_B, [ORG_B])
      const res = await POST(post({ hostname: 'new.example.com', organizationId: ORG_B }))
      expect(res.status).toBe(201)
    })

    it('registers for any tenant organization when unrestricted', async () => {
      asCallerIn(ORG_B, null)
      const res = await POST(post({ hostname: 'new.example.com', organizationId: ORG_A }))
      expect(res.status).toBe(201)
    })

    it('answers 404 and creates nothing when a caller without access to the replaced mapping names its id', async () => {
      asCallerIn(ORG_B, [ORG_B])
      const res = await POST(post({ hostname: 'new.example.com', organizationId: ORG_B, replacesDomainId: DOMAIN_A }))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ ok: false, error: 'Not found' })
      expect(mockEm.persist).not.toHaveBeenCalled()
    })

    it('answers the same 404 for a replacesDomainId that does not exist', async () => {
      asCallerIn(ORG_B, [ORG_B])
      const res = await POST(
        post({ hostname: 'new.example.com', organizationId: ORG_B, replacesDomainId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
      )
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ ok: false, error: 'Not found' })
    })

    it('rejects every organization for a caller with an empty accessible set', async () => {
      asCallerIn(ORG_B, [])
      const res = await POST(post({ hostname: 'new.example.com', organizationId: ORG_B }))
      expect(res.status).toBe(403)
      expect(mockEm.persist).not.toHaveBeenCalled()
    })

    it('registers for an accessible organization outside the header switcher selection', async () => {
      asCallerIn(ORG_B, [ORG_A, ORG_B], [ORG_B])
      const res = await POST(post({ hostname: 'new.example.com', organizationId: ORG_A }))
      expect(res.status).toBe(201)
    })

    it('rejects replacesDomainId that belongs to another organization with 422', async () => {
      asCallerIn(ORG_B, [ORG_A, ORG_B])
      const res = await POST(post({ hostname: 'new.example.com', organizationId: ORG_B, replacesDomainId: DOMAIN_A }))
      expect(res.status).toBe(422)
      expect(mockEm.persist).not.toHaveBeenCalled()
    })

    it('accepts replacesDomainId from the same organization', async () => {
      asCallerIn(ORG_B, [ORG_B])
      const res = await POST(post({ hostname: 'new.example.com', organizationId: ORG_B, replacesDomainId: DOMAIN_B }))
      expect(res.status).toBe(201)
    })
  })

  describe('DELETE', () => {
    it('returns 404 and keeps the row when it belongs to an inaccessible organization', async () => {
      asCallerIn(ORG_B, [ORG_B])
      const res = await DELETE(new Request(`${url}?id=${DOMAIN_A}`, { method: 'DELETE' }))
      expect(res.status).toBe(404)
      expect(store.has(DOMAIN_A)).toBe(true)
    })

    it('removes a row of an accessible organization', async () => {
      asCallerIn(ORG_B, [ORG_B])
      const res = await DELETE(new Request(`${url}?id=${DOMAIN_B}`, { method: 'DELETE' }))
      expect(res.status).toBe(200)
      expect(store.has(DOMAIN_B)).toBe(false)
    })

    it('returns 404 for a caller with an empty accessible set', async () => {
      asCallerIn(ORG_B, [])
      const res = await DELETE(new Request(`${url}?id=${DOMAIN_B}`, { method: 'DELETE' }))
      expect(res.status).toBe(404)
      expect(store.has(DOMAIN_B)).toBe(true)
    })

    it('removes any tenant row when unrestricted', async () => {
      asCallerIn(ORG_B, null)
      const res = await DELETE(new Request(`${url}?id=${DOMAIN_A}`, { method: 'DELETE' }))
      expect(res.status).toBe(200)
      expect(store.has(DOMAIN_A)).toBe(false)
    })
  })

  describe('verify', () => {
    const verifySpy = () =>
      jest.spyOn(DomainMappingService.prototype, 'verify').mockImplementation(async (id: string) => ({
        domainMapping: store.get(id) as unknown as DomainMapping,
      }))

    afterEach(() => jest.restoreAllMocks())

    it('returns 404 without verifying a row of an inaccessible organization', async () => {
      const spy = verifySpy()
      asCallerIn(ORG_B, [ORG_B])
      const res = await VERIFY(new Request(url, { method: 'POST' }), routeCtx(DOMAIN_A))
      expect(res.status).toBe(404)
      expect(spy).not.toHaveBeenCalled()
    })

    it('verifies a row of an accessible organization', async () => {
      const spy = verifySpy()
      asCallerIn(ORG_B, [ORG_B])
      const res = await VERIFY(new Request(url, { method: 'POST' }), routeCtx(DOMAIN_B))
      expect(res.status).toBe(200)
      expect(spy).toHaveBeenCalledWith(DOMAIN_B, { tenantId: TENANT, organizationIds: [ORG_B] })
    })

    it('returns 404 for a caller with an empty accessible set', async () => {
      const spy = verifySpy()
      asCallerIn(ORG_B, [])
      const res = await VERIFY(new Request(url, { method: 'POST' }), routeCtx(DOMAIN_B))
      expect(res.status).toBe(404)
      expect(spy).not.toHaveBeenCalled()
    })

    it('does not leak the failure message', async () => {
      jest.spyOn(DomainMappingService.prototype, 'verify').mockRejectedValue(new Error('resolver at 10.0.0.1 failed'))
      asCallerIn(ORG_B, [ORG_B])
      const res = await VERIFY(new Request(url, { method: 'POST' }), routeCtx(DOMAIN_B))
      expect(res.status).toBe(500)
      expect(JSON.stringify(await res.json())).not.toContain('10.0.0.1')
    })

    it('verifies any tenant row when unrestricted', async () => {
      const spy = verifySpy()
      asCallerIn(ORG_B, null)
      const res = await VERIFY(new Request(url, { method: 'POST' }), routeCtx(DOMAIN_A))
      expect(res.status).toBe(200)
      expect(spy).toHaveBeenCalledWith(DOMAIN_A, { tenantId: TENANT, organizationIds: null })
    })
  })

  describe('health-check', () => {
    const healthSpy = () =>
      jest.spyOn(DomainMappingService.prototype, 'healthCheck').mockImplementation(
        async (id: string) => store.get(id) as unknown as DomainMapping,
      )

    afterEach(() => jest.restoreAllMocks())

    it('returns 404 without probing a row of an inaccessible organization', async () => {
      const spy = healthSpy()
      asCallerIn(ORG_B, [ORG_B])
      const res = await HEALTH_CHECK(new Request(url, { method: 'POST' }), routeCtx(DOMAIN_A))
      expect(res.status).toBe(404)
      expect(spy).not.toHaveBeenCalled()
    })

    it('returns 404 for a caller with an empty accessible set', async () => {
      const spy = healthSpy()
      asCallerIn(ORG_B, [])
      const res = await HEALTH_CHECK(new Request(url, { method: 'POST' }), routeCtx(DOMAIN_B))
      expect(res.status).toBe(404)
      expect(spy).not.toHaveBeenCalled()
    })

    it('probes a row of an accessible organization', async () => {
      const spy = healthSpy()
      asCallerIn(ORG_B, [ORG_B])
      const res = await HEALTH_CHECK(new Request(url, { method: 'POST' }), routeCtx(DOMAIN_B))
      expect(res.status).toBe(200)
      expect(spy).toHaveBeenCalledWith(DOMAIN_B, { tenantId: TENANT, organizationIds: [ORG_B] })
    })
  })
})

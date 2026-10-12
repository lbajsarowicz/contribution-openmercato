/** @jest-environment node */
import type { EntityManager } from '@mikro-orm/postgresql'
import { DomainMapping } from '@open-mercato/core/modules/customer_accounts/data/entities'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'

const mockGetAuth = jest.fn()
const mockLoadAcl = jest.fn()
const mockRbac = { userHasAllFeatures: jest.fn(), loadAcl: mockLoadAcl }

type Row = Record<string, unknown> & { id: string; organizationId: string; tenantId: string }

const store = new Map<string, Row>()
const orgIds = new Set<string>()

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, raw]) => {
    const value = row[key]
    if (raw && typeof raw === 'object' && '$in' in (raw as Record<string, unknown>)) {
      return ((raw as { $in: unknown[] }).$in).includes(value)
    }
    return value === raw
  })
}

const mockEm = {
  find: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
    if (entity === DomainMapping) return Array.from(store.values()).filter((row) => matches(row, where))
    if (entity === Organization) {
      const ids = ((where.id as { $in: string[] }).$in) ?? []
      return ids.filter((id) => orgIds.has(id)).map((id) => ({ id, descendantIds: [] }))
    }
    return []
  }),
  findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
    if (entity === DomainMapping) return Array.from(store.values()).find((row) => matches(row, where)) ?? null
    return null
  }),
  create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({
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
      const [organizationId] = params as [string, string]
      return orgIds.has(organizationId) ? [{ slug: null }] : []
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

jest.mock('@open-mercato/core/modules/customer_accounts/events', () => ({
  emitCustomerAccountsEvent: jest.fn(async () => undefined),
}))

import { DomainMappingService } from '@open-mercato/core/modules/customer_accounts/services/domainMappingService'
import { GET, POST, DELETE } from '@open-mercato/core/modules/customer_accounts/api/admin/domain-mappings'
import { POST as VERIFY } from '@open-mercato/core/modules/customer_accounts/api/admin/domain-mappings/[id]/verify'

const service = new DomainMappingService(mockEm as unknown as EntityManager)
const mockContainer = {
  resolve: jest.fn((token: string) => {
    if (token === 'rbacService') return mockRbac
    if (token === 'em') return mockEm
    if (token === 'domainMappingService') return service
    throw new Error(`unregistered ${token}`)
  }),
}

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG_A = '22222222-2222-4222-8222-222222222222'
const ORG_B = '33333333-3333-4333-8333-333333333333'
const ORG_C = '55555555-5555-4555-8555-555555555555'
const ADMIN = '44444444-4444-4444-8444-444444444444'
const DOMAIN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DOMAIN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DOMAIN_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const url = 'http://localhost/api/customer_accounts/admin/domain-mappings'

function seed(id: string, organizationId: string) {
  store.set(id, {
    id,
    hostname: `${id.slice(0, 4)}.example.com`,
    tenantId: TENANT,
    organizationId,
    status: 'verified',
    provider: 'traefik',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  })
}

function request(path = '', init: RequestInit = {}, selectedOrg?: string) {
  const headers = new Headers(init.headers)
  if (selectedOrg) headers.set('cookie', `om_selected_org=${selectedOrg}`)
  return new Request(`${url}${path}`, { ...init, headers })
}

function postBody(body: unknown, selectedOrg?: string) {
  return request('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, selectedOrg)
}

const listedIds = async (res: Response) =>
  ((await res.json()).domainMappings as Array<{ id: string }>).map((m) => m.id).sort()

function asRestrictedCaller(organizations: string[]) {
  mockGetAuth.mockResolvedValue({ sub: ADMIN, tenantId: TENANT, orgId: ORG_B })
  mockLoadAcl.mockResolvedValue({ isSuperAdmin: false, features: [], organizations })
}

function asUnrestrictedCaller() {
  mockGetAuth.mockResolvedValue({ sub: ADMIN, tenantId: TENANT, orgId: ORG_B })
  mockLoadAcl.mockResolvedValue({ isSuperAdmin: false, features: [], organizations: null })
}

function asSuperAdmin() {
  mockGetAuth.mockResolvedValue({ sub: ADMIN, tenantId: TENANT, orgId: ORG_B, isSuperAdmin: true })
  mockLoadAcl.mockResolvedValue({ isSuperAdmin: true, features: ['*'], organizations: null })
}

beforeEach(() => {
  jest.clearAllMocks()
  store.clear()
  orgIds.clear()
  ;[ORG_A, ORG_B, ORG_C].forEach((id) => orgIds.add(id))
  mockRbac.userHasAllFeatures.mockResolvedValue(true)
  seed(DOMAIN_A, ORG_A)
  seed(DOMAIN_B, ORG_B)
  seed(DOMAIN_C, ORG_C)
})

describe('admin domain-mappings with the real organization scope resolver', () => {
  it('confines a caller whose ACL covers only organization B', async () => {
    asRestrictedCaller([ORG_B])

    expect(await listedIds(await GET(request()))).toEqual([DOMAIN_B])
    expect(await listedIds(await GET(request(`?organizationId=${ORG_A}`)))).toEqual([])
    expect((await DELETE(request(`?id=${DOMAIN_A}`, { method: 'DELETE' }))).status).toBe(404)
    expect(store.has(DOMAIN_A)).toBe(true)
    expect((await VERIFY(request('', { method: 'POST' }), { params: Promise.resolve({ id: DOMAIN_A }) })).status).toBe(404)
    expect((await POST(postBody({ hostname: 'new.example.com', organizationId: ORG_A }))).status).toBe(403)
  })

  it('answers 404 and creates nothing when a B-only caller supersedes A with replacesDomainId', async () => {
    asRestrictedCaller([ORG_B])

    const res = await POST(postBody({ hostname: 'new.example.com', organizationId: ORG_B, replacesDomainId: DOMAIN_A }))

    expect(res.status).toBe(404)
    expect(mockEm.persist).not.toHaveBeenCalled()
    expect(store.has(DOMAIN_A)).toBe(true)
  })

  it('treats an empty ACL organization list as no access', async () => {
    asRestrictedCaller([])

    expect(await listedIds(await GET(request()))).toEqual([])
    expect((await DELETE(request(`?id=${DOMAIN_B}`, { method: 'DELETE' }))).status).toBe(404)
  })

  it('lets the page picker address accessible organization A while the switcher sits on B', async () => {
    asRestrictedCaller([ORG_A, ORG_B])

    expect(await listedIds(await GET(request('', {}, ORG_B)))).toEqual([DOMAIN_B])
    expect(await listedIds(await GET(request(`?organizationId=${ORG_A}`, {}, ORG_B)))).toEqual([DOMAIN_A])
    expect((await POST(postBody({ hostname: 'new.example.com', organizationId: ORG_A }, ORG_B))).status).toBe(201)
  })

  it('gives a superadmin access to every organization of the tenant', async () => {
    asSuperAdmin()

    expect(await listedIds(await GET(request()))).toEqual([DOMAIN_A, DOMAIN_B, DOMAIN_C].sort())
    expect((await DELETE(request(`?id=${DOMAIN_A}`, { method: 'DELETE' }))).status).toBe(200)
    expect(store.has(DOMAIN_A)).toBe(false)
  })

  it('lists every organization in "All organizations" mode for an unrestricted caller', async () => {
    asUnrestrictedCaller()

    expect(await listedIds(await GET(request('', {}, '__all__')))).toEqual([DOMAIN_A, DOMAIN_B, DOMAIN_C].sort())
    expect(await listedIds(await GET(request()))).toEqual([DOMAIN_B])
  })
})

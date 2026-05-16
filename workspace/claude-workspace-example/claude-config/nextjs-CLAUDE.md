# Next.js — Development Practices

## Project Structure

```
app/
├── layout.tsx            # Root layout (required)
├── page.tsx              # Home page (/)
├── loading.tsx           # Loading UI (auto Suspense boundary)
├── error.tsx             # Error UI (auto Error boundary — must be 'use client')
├── not-found.tsx         # 404 UI
├── global-error.tsx      # Catches errors in root layout (needs <html><body>)
├── forbidden.tsx         # 403 UI
├── unauthorized.tsx      # 401 UI
├── route.ts              # API endpoint (cannot coexist with page.tsx)
├── (group)/              # Route group — no URL impact
│   └── page.tsx
├── [slug]/               # Dynamic segment
│   └── page.tsx
├── [...slug]/            # Catch-all
└── @slot/                # Parallel route slot
    └── page.tsx
lib/
├── data.ts               # Server-side data fetching (React.cache wrappers)
└── actions.ts            # Server Actions
components/
├── ui/                   # Shared UI (generic, no data fetching)
└── <feature>/            # Feature-specific components
```

---

## Directives

```tsx
'use client'   // React: marks Client Component — required for hooks, event handlers, browser APIs
'use server'   // React: marks Server Action — runs on server, can be passed to clients
'use cache'    // Next.js: marks function/component for caching (requires cacheComponents: true)
```

**Rules:**
- `'use client'` goes at the top of the file, before imports
- Client Components **cannot** be `async` functions
- Server Actions must be `async`; can be in a separate `actions.ts` file or inline with `'use server'` inside a server component function

---

## RSC Boundaries

### Client Components cannot be async

```tsx
// Bad
'use client'
export default async function UserProfile() {
  const user = await getUser() // Cannot await in client component
  return <div>{user.name}</div>
}

// Good — fetch in server parent, pass data down
export default async function Page() {
  const user = await getUser()
  return <UserProfile user={user} />
}

'use client'
export function UserProfile({ user }: { user: User }) {
  return <div>{user.name}</div>
}
```

### Props from Server → Client must be serializable

| Prop type | Valid? | Fix |
|-----------|--------|-----|
| `string / number / boolean` | Yes | — |
| Plain object / array | Yes | — |
| Server Action (`'use server'`) | Yes | — |
| `() => {}` regular function | No | Define in client or use Server Action |
| `new Date()` | No | `.toISOString()` before passing |
| `new Map() / new Set()` | No | Convert to object / array |
| Class instance | No | Pass plain object |

```tsx
// Bad: Date object becomes string silently, then crashes on .getFullYear()
<PostCard createdAt={post.createdAt} />

// Good: serialize on the server
<PostCard createdAt={post.createdAt.toISOString()} />
```

---

## Async Params / SearchParams (Next.js 15+)

Always type as `Promise<...>` and await.

```tsx
// Page
type Props = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ query?: string }>
}

export default async function Page({ params, searchParams }: Props) {
  const { slug } = await params
  const { query } = await searchParams
}

// Route Handler
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
}

// generateMetadata
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  return { title: slug }
}

// Synchronous component — use React.use()
import { use } from 'react'
export default function Page({ params }: Props) {
  const { slug } = use(params)
}
```

### Async cookies / headers

```tsx
import { cookies, headers } from 'next/headers'

export default async function Page() {
  const cookieStore = await cookies()
  const headersList = await headers()
  const theme = cookieStore.get('theme')
}
```

---

## Data Patterns

### Decision tree

```
Need to fetch data?
├── Server Component?          → fetch directly (no API needed)
├── Mutation from UI?          → Server Action
├── Read in Client Component?  → pass from server parent (preferred) or Route Handler
└── External / webhook / REST? → Route Handler
```

### Pattern 1 — Server Component reads (preferred)

```tsx
async function UsersPage() {
  const users = await db.user.findMany()
  return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>
}
```

### Pattern 2 — Server Actions for mutations

```tsx
// lib/actions.ts
'use server'
import { revalidatePath } from 'next/cache'

export async function createPost(formData: FormData) {
  const title = formData.get('title') as string
  await db.post.create({ data: { title } })
  revalidatePath('/posts')
}
```

```tsx
// Form — works without JS (progressive enhancement)
import { createPost } from '@/lib/actions'

export default function NewPost() {
  return (
    <form action={createPost}>
      <input name="title" required />
      <button type="submit">Create</button>
    </form>
  )
}
```

### Pattern 3 — Route Handlers (external APIs)

```tsx
// app/api/posts/route.ts
export async function GET() {
  const posts = await db.post.findMany()
  return Response.json(posts)
}

export async function POST(request: Request) {
  const body = await request.json()
  const post = await db.post.create({ data: body })
  return Response.json(post, { status: 201 })
}

// Dynamic route — app/api/posts/[id]/route.ts
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const post = await db.post.findUnique({ where: { id } })
  if (!post) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json(post)
}
```

**`route.ts` and `page.tsx` cannot coexist in the same folder.**

### Avoiding data waterfalls

```tsx
// Bad: sequential
const user = await getUser()
const posts = await getPosts()

// Good: parallel
const [user, posts] = await Promise.all([getUser(), getPosts()])

// Good: streaming with Suspense
export default function Dashboard() {
  return (
    <>
      <Suspense fallback={<UserSkeleton />}><UserSection /></Suspense>
      <Suspense fallback={<PostsSkeleton />}><PostsSection /></Suspense>
    </>
  )
}

// Good: preload pattern (deduplicated with React.cache)
export const getUser = cache(async (id: string) => db.user.findUnique({ where: { id } }))
export const preloadUser = (id: string) => { void getUser(id) }
```

---

## Error Handling

```tsx
// error.tsx — must be 'use client'
'use client'
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div>
      <h2>Something went wrong</h2>
      <button onClick={reset}>Try again</button>
    </div>
  )
}

// Trigger 404 from a server component or server action
import { notFound } from 'next/navigation'
if (!post) notFound()

// Trigger auth errors
import { forbidden, unauthorized } from 'next/navigation'
if (!session) unauthorized()
if (!session.hasAccess) forbidden()
```

### Never catch redirect / notFound in try-catch

```tsx
// Bad: redirect() throws internally — catch swallows it
async function action(formData: FormData) {
  try {
    const post = await db.post.create({ ... })
    redirect(`/posts/${post.id}`) // throws!
  } catch (error) {
    return { error: 'Failed' } // navigation never happens
  }
}

// Good: call redirect outside try-catch
async function action(formData: FormData) {
  let post
  try {
    post = await db.post.create({ ... })
  } catch (error) {
    return { error: 'Failed' }
  }
  redirect(`/posts/${post.id}`)
}

// Good: use unstable_rethrow when you must catch
import { unstable_rethrow } from 'next/navigation'
async function action() {
  try {
    redirect('/success')
  } catch (error) {
    unstable_rethrow(error)
    return { error: 'Something went wrong' }
  }
}
```

---

## Image Optimization

Always use `next/image` — never native `<img>`.

```tsx
import Image from 'next/image'

// Local image — dimensions inferred automatically
import heroImage from './hero.png'
<Image src={heroImage} alt="Hero" placeholder="blur" priority />

// Remote image — must configure remotePatterns in next.config.js
<Image src="https://cdn.example.com/photo.jpg" alt="Photo" width={800} height={400} />

// Fill parent container
<div style={{ position: 'relative', height: 400 }}>
  <Image src="/hero.png" alt="Hero" fill sizes="100vw" style={{ objectFit: 'cover' }} priority />
</div>

// Responsive grid
<Image src="/card.png" alt="Card" fill sizes="(max-width: 768px) 100vw, 33vw" />
```

```js
// next.config.js
module.exports = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.example.com', pathname: '/images/**' },
    ],
  },
}
```

---

## Middleware (v14–15) / Proxy (v16+)

```ts
// middleware.ts (v14–15) | proxy.ts (v16+)
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {  // v16: export function proxy(...)
  return NextResponse.next()
}

export const config = {   // v16: export const proxyConfig
  matcher: ['/dashboard/:path*', '/api/:path*'],
}
```

---

## Unit Tests — Components (`*.spec.tsx` in `tests/unit/`)

### Rules

1. **All `jest.mock(...)` at the top** — before any imports; mock `next/image`, `next/navigation`, `@/app/actions`, `lucide-react`, `react-dom`, etc.
2. **`jest.clearAllMocks()` in every `beforeEach`.**
3. **Render inside each `it`** — never in `beforeEach`/`beforeAll`.
4. **`screen.queryBy*` for absent elements**, `getBy*` when expecting presence.
5. **`fireEvent` for interactions** within the same `it`.
6. **No snapshot tests** — assert specific DOM elements, text, and attributes.
7. **Do not test implementation details** — assert what the user sees.

```tsx
jest.mock('next/image', () => ({ __esModule: true, default: (props: any) => <img {...props} /> }))
jest.mock('@/app/actions', () => ({ myAction: jest.fn() }))
jest.mock('react-dom', () => ({
  ...jest.requireActual('react-dom'),
  useFormStatus: jest.fn(() => ({ pending: false })),
}))

const mockDispatch = jest.fn()

describe('MyComponent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should render initial state', () => {
    render(<MyComponent state={undefined} dispatch={mockDispatch} />)

    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('should show error when state has error', () => {
    render(
      <MyComponent
        state={{ success: false, error: 'Something went wrong' }}
        dispatch={mockDispatch}
      />,
    )

    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })

  it('should handle user input', () => {
    render(<MyComponent dispatch={mockDispatch} />)

    const emailInput = screen.getByLabelText('Email')
    fireEvent.change(emailInput, { target: { value: 'test@email.com' } })
    expect(emailInput).toHaveValue('test@email.com')
  })

  it('should show loading state', () => {
    jest.mocked(useFormStatus).mockReturnValue({ pending: true } as any)
    render(<MyComponent dispatch={mockDispatch} />)

    expect(screen.getByRole('button')).toBeDisabled()
  })
})
```

---

## Integration Tests — API (`test/*.spec.ts`)

### Rules

1. **`beforeAll`** — bootstrap app only; no shared data setup.
2. **`afterEach`** — `prisma.<table>.deleteMany()` so each test starts clean.
3. **`afterAll`** — `app.close()`.
4. **Token per test** — call `jwtService.sign(...)` inside each `it`.
5. **Data inside `it`** — use `faker` for unique values; never share across tests.
6. **No mock assertions** — assert HTTP status + response body only.
7. **`toMatchObject`** — use `expect.any(String)` for `id`, `createdAt`, `updatedAt`.
8. **Order-independent lists** — `expect.arrayContaining([expect.objectContaining(...)])`.

```typescript
const API_KEY = process.env.API_KEY ?? 'local-api-key'

describe('POST /resource', () => {
  let app: INestApplication
  let jwtService: JwtService

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.useGlobalPipes(new ZodValidationPipe())
    await app.init()
    jwtService = module.get(JwtService)
    await prisma.resource.deleteMany()
  })

  afterEach(async () => {
    await prisma.resource.deleteMany()
  })

  afterAll(async () => {
    await app.close()
  })

  it('should create resource and return 201', async () => {
    const token = jwtService.sign({ sub: randomUUID(), email: faker.internet.email(), role: 'ADMIN' })

    const response = await request(app.getHttpServer())
      .post('/resource')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: faker.word.noun() })
      .expect(201)

    expect(response.body).toMatchObject({
      id: expect.any(String),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })
  })

  it('should return 401 without api key', async () => {
    const token = jwtService.sign({ sub: randomUUID(), email: faker.internet.email(), role: 'ADMIN' })

    await request(app.getHttpServer())
      .post('/resource')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(401)
  })
})
```

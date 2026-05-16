# NestJS API — Development Practices

## Project Structure

```
apps/api/src/
  core/<feature>/          # One directory per domain feature
    dto/                   # Zod-based DTOs
    models/                # Domain types / response models
    repository/            # Prisma data access
    services/              # Business logic
    <feature>.controller.ts
    <feature>.module.ts
  common/
    decorators/            # @CurrentUser, @Roles, @Public
    guards/                # ApiKey, JWT, Roles, OwnerOrPrivileged
    filters/               # HttpExceptionFilter
    prisma/                # PrismaModule / PrismaService
```

---

## NestJS App

### Module registration

Every feature lives in its own module. Export only what other modules need; never add providers twice.

```typescript
@Module({
  imports: [PrismaModule],
  controllers: [FeatureController],
  providers: [FeatureService, FeatureRepository],
  exports: [FeatureService],       // only export if another module imports this one
})
export class FeatureModule {}
```

### Global setup (`main.ts`)

```typescript
app.useGlobalPipes(new ZodValidationPipe());    // always — validation at the boundary
app.useGlobalFilters(new HttpExceptionFilter()); // always — consistent error shape
```

---

## NestJS Endpoints

### Controller rules

- Thin controllers — delegate all logic to the service.
- Declare the return type explicitly (`Promise<FeatureResponseDto>`).
- Annotate `@HttpCode` only when the default (200) is wrong.
- Use `@CurrentUser()` to access the authenticated user; never pass the raw `Request`.

```typescript
@Controller('features')
export class FeatureController {
  constructor(private readonly featureService: FeatureService) {}

  @Get()
  @Roles(Role.ADMIN)
  async findAll(): Promise<FeatureResponseDto[]> {
    return this.featureService.listAll();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.ADMIN)
  async create(
    @Body() dto: CreateFeatureDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<FeatureResponseDto> {
    return this.featureService.create(dto, currentUser);
  }

  @Patch(':id')
  @UseGuards(OwnerOrPrivilegedGuard)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFeatureDto,
  ): Promise<FeatureResponseDto> {
    return this.featureService.update(id, dto);
  }
}
```

### DTOs (Zod + nestjs-zod)

```typescript
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createFeatureSchema = z.object({
  name: z.string().min(1),
  email: z.email().transform((val) => val.toLowerCase()),
});

export class CreateFeatureDto extends createZodDto(createFeatureSchema) {}
```

### Repository rules

- Use a typed `satisfies Prisma.<Model>Select` constant for `select` — never inline field lists.
- Export the inferred `Prisma.GetPayload` type for use in services.
- Use arrow function syntax for all methods.

```typescript
const featureSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FeatureSelect;

export type FeatureData = Prisma.FeatureGetPayload<{ select: typeof featureSelect }>;

@Injectable()
export class FeatureRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById = async (id: string): Promise<FeatureData | null> =>
    this.prisma.feature.findUnique({ where: { id }, select: featureSelect });

  findAll = async (): Promise<FeatureData[]> =>
    this.prisma.feature.findMany({ select: featureSelect });

  create = async (data: CreateFeatureDto & { createdBy: string }): Promise<FeatureData> =>
    this.prisma.feature.create({ data: { ...data }, select: featureSelect });

  update = async (id: string, data: UpdateFeatureDto): Promise<FeatureData> =>
    this.prisma.feature.update({ where: { id }, data: { ...data }, select: featureSelect });
}
```

### Service rules

- Use arrow function syntax for all methods.
- Throw NestJS HTTP exceptions (`NotFoundException`, `ConflictException`, etc.) — never raw `Error`.
- Use a private `toResponse` helper to centralise null-checks and type assertions.

```typescript
@Injectable()
export class FeatureService {
  constructor(private readonly featureRepository: FeatureRepository) {}

  private toResponse = (
    item: Awaited<ReturnType<FeatureRepository['findById']>>,
  ): FeatureResponseDto => {
    if (!item) throw new NotFoundException('Not found');
    return item as FeatureResponseDto;
  };

  getById = async (id: string): Promise<FeatureResponseDto> => {
    const item = await this.featureRepository.findById(id);
    return this.toResponse(item);
  };

  create = async (
    dto: CreateFeatureDto,
    requestingUser: AuthenticatedUser,
  ): Promise<FeatureResponseDto> => {
    const item = await this.featureRepository.create({
      ...dto,
      createdBy: requestingUser.id,
    });
    return this.toResponse(item);
  };
}
```

---

## Unit Tests (`*.spec.ts` inside `src/`)

### Rules

1. **Mock object at module level** — `const mock = { method: jest.fn() }` outside all `describe` blocks.
2. **`jest.clearAllMocks()` in every `beforeEach`** — prevents call counts leaking.
3. **Mock setup inside `it`** — `mock.method.mockResolvedValue(...)` belongs in the test, not `beforeEach`.
4. **Always validate called functions** — assert the dependency was called with the right args.
5. **`toMatchObject` for result data** — partial matching. Reserve `toEqual` for primitives and empty arrays.
6. **Error paths** — `.rejects.toThrow(ExceptionClass)`. No mock-call assertion needed.
7. **Factory functions inside `it`** — define `const existing = () => ({...})` locally when the same shape is reused within a test.

### Service spec template

```typescript
const repositoryMock = {
  findById: jest.fn(),
  findAll: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};

describe('FeatureService', () => {
  let service: FeatureService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        FeatureService,
        { provide: FeatureRepository, useValue: repositoryMock },
      ],
    }).compile();
    service = module.get(FeatureService);
  });

  it('should return item when it exists', async () => {
    const id = randomUUID();
    repositoryMock.findById.mockResolvedValue({ id, name: 'Test' });

    const result = await service.getById(id);

    expect(repositoryMock.findById).toHaveBeenCalledWith(id);
    expect(result).toMatchObject({ id, name: 'Test' });
  });

  it('should throw NotFoundException when item does not exist', async () => {
    repositoryMock.findById.mockResolvedValue(null);
    await expect(service.getById(randomUUID())).rejects.toThrow(NotFoundException);
  });

  it('should update item using factory pattern', async () => {
    const mockId = randomUUID();
    const existing = () => ({ id: mockId, name: 'Old' });
    const updated = (overrides = {}) => ({ ...existing(), ...overrides });

    repositoryMock.findById.mockResolvedValue(existing());
    repositoryMock.update.mockResolvedValue(updated({ name: 'New' }));

    const result = await service.update(mockId, { name: 'New' });

    expect(repositoryMock.update).toHaveBeenCalledWith(mockId, { name: 'New' });
    expect(result).toMatchObject({ name: 'New' });
  });
});
```

### Repository spec template

Always validate the **full Prisma call shape** including `select`.

```typescript
const prismaMock = {
  feature: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

describe('FeatureRepository', () => {
  let repository: FeatureRepository;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        FeatureRepository,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    repository = module.get(FeatureRepository);
  });

  it('should find item by id with select', async () => {
    const id = randomUUID();
    prismaMock.feature.findUnique.mockResolvedValue({ id, name: 'Test' });

    const result = await repository.findById(id);

    expect(prismaMock.feature.findUnique).toHaveBeenCalledWith({
      where: { id },
      select: featureSelect,    // always validate full call shape
    });
    expect(result).toMatchObject({ id });
  });
});
```

---

## Integration Tests (`test/*.spec.ts`)

### Setup helpers

- `createTestApp()` — bootstraps `AppModule` with `ZodValidationPipe`, returns `{ app, jwtService, createItem }`.
- `init()` — seeds static reference data needed by all suites.
- `prisma` — used for cleanup between tests.

### Rules

1. **`beforeAll`** — bootstrap app + seed static data only.
2. **`afterEach`** — `prisma.<table>.deleteMany()` so each test starts clean.
3. **`afterAll`** — `app.close()`.
4. **Token per test** — define `const makeToken = (role) => jwtService.sign({...})` at describe scope; call it inside `it`.
5. **Data inside `it`** — use `faker` for unique values; never share data across tests.
6. **No mock assertions** — assert HTTP status + response body only.
7. **`toMatchObject`** — use `expect.any(String)` for `id`, `createdAt`, `updatedAt`.
8. **Order-independent lists** — `expect.arrayContaining([expect.objectContaining(...)])`.

### Integration spec template

```typescript
const API_KEY = process.env.API_KEY ?? 'local-api-key';

describe('POST /features', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
    await init();
  });

  afterEach(async () => {
    await prisma.feature.deleteMany();
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  const makeToken = (role: string) =>
    testApp.jwtService.sign({ sub: randomUUID(), email: faker.internet.email(), role });

  it('should create item and return 201', async () => {
    const response = await request(testApp.app.getHttpServer())
      .post('/features')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: faker.word.noun() })
      .expect(201);

    expect(response.body).toMatchObject({
      id: expect.any(String),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('should return 401 without api key', async () => {
    await request(testApp.app.getHttpServer())
      .post('/features')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({})
      .expect(401);
  });
});
```

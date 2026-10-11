import { FakeService, assigned, tokenFor, settle, platform, loadSdk, stopTimers } from './helpers';

type Sdk = ReturnType<typeof loadSdk>;

/** The send interval and the list cache the console sets, and the time on each event. */
describe('what the console says', () => {
  let service: FakeService;
  let sdk: Sdk;
  let errors: unknown[];
  let now: number;
  let timers: jest.SpyInstance;

  /** The interval of the send timer that is running now, in milliseconds. */
  const sendInterval = (): number => timers.mock.calls[timers.mock.calls.length - 1][1] as number;
  const config = (value: Record<string, unknown>): void => {
    service.routes['/public/init'] = { body: { experiments: [], config: value } };
  };
  const start = async (extra: Record<string, unknown> = {}): Promise<void> => {
    await sdk.init({ apiKey: 'rv_test_key', userToken: tokenFor('user-1'), ...extra });
    await settle();
  };

  beforeEach(() => {
    platform.install();
    service = new FakeService();
    service.install();
    service.routes['/public/assign'] = assigned('blue');
    sdk = loadSdk();
    errors = [];
    sdk.on('error', (e) => errors.push(e.data));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    timers = jest.spyOn(globalThis, 'setInterval');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await sdk.reset();
    stopTimers();
  });

  describe('the send interval', () => {
    it('follows the console', async () => {
      config({ syncIntervalSeconds: 60, cacheTtlSeconds: 120 });
      await start();

      expect(sendInterval()).toBe(60_000);
    });

    it('stays at the built-in 30 seconds when the console says nothing', async () => {
      await start();

      expect(sendInterval()).toBe(30_000);
    });

    it('is the app\'s own when the app passed one', async () => {
      config({ syncIntervalSeconds: 60 });
      await start({ flushInterval: 5000 });

      expect(sendInterval()).toBe(5000);
      expect(timers).toHaveBeenCalledTimes(1);
    });

    it('is never shorter than 10 seconds or longer than an hour because of the console', async () => {
      config({ syncIntervalSeconds: 1 });
      await start();
      expect(sendInterval()).toBe(10_000);
    });

    it('ignores a value that is not a whole number above zero', async () => {
      config({ syncIntervalSeconds: 0, cacheTtlSeconds: 0 });
      await start();
      for (const bad of [-5, 12.5, '45', null, true]) {
        config({ syncIntervalSeconds: bad, cacheTtlSeconds: bad });
        await sdk.refreshExperiments();
      }

      expect(sendInterval()).toBe(30_000);
    });

    it('changes with the next refresh, without a restart', async () => {
      config({ syncIntervalSeconds: 60 });
      await start();
      expect(sendInterval()).toBe(60_000);

      config({ syncIntervalSeconds: 99999999 });
      await sdk.refreshExperiments();
      expect(sendInterval()).toBe(3_600_000);

      config({ syncIntervalSeconds: 45 });
      await sdk.refreshExperiments();
      expect(sendInterval()).toBe(45_000);
    });
  });

  describe('the experiment list', () => {
    it('is reused while it is fresh and asked for again once it is stale', async () => {
      config({ cacheTtlSeconds: 120 });
      await start();
      const loads = service.to('/public/init').length;

      now += 119_000;
      for (let i = 0; i < 5; i++) await sdk.getVariant('checkout');
      await settle();
      expect(service.to('/public/init')).toHaveLength(loads);

      // The console changed the cache time in the meantime.
      config({ cacheTtlSeconds: 600 });
      now += 2000;
      await Promise.all([1, 2, 3, 4, 5].map(() => sdk.getVariant('checkout')));
      await settle();
      // One request, however many callers.
      expect(service.to('/public/init')).toHaveLength(loads + 1);

      // The new value is in use without a restart.
      now += 599_000;
      await sdk.getVariant('checkout');
      await settle();
      expect(service.to('/public/init')).toHaveLength(loads + 1);
      now += 2000;
      await sdk.trackView('checkout');
      await settle();
      expect(service.to('/public/init')).toHaveLength(loads + 2);
    });

    it('is never asked for more than once a minute because of the console', async () => {
      config({ cacheTtlSeconds: 1 });
      await start();
      const loads = service.to('/public/init').length;

      now += 59_000;
      await sdk.getVariant('checkout');
      await settle();
      expect(service.to('/public/init')).toHaveLength(loads);

      now += 2000;
      await sdk.getVariant('checkout');
      await settle();
      expect(service.to('/public/init')).toHaveLength(loads + 1);
    });

    it('a refresh that fails is not repeated on every call and is not an error', async () => {
      await start();
      const loads = service.to('/public/init').length;
      errors.length = 0;

      service.routes['/public/init'] = new Error('offline');
      now += 301_000;
      for (let i = 0; i < 5; i++) {
        await sdk.getVariant('checkout');
        await settle();
      }
      expect(service.to('/public/init')).toHaveLength(loads + 1);
      expect(errors).toEqual([]);

      config({});
      now += 61_000;
      await sdk.getVariant('checkout');
      await settle();
      expect(service.to('/public/init')).toHaveLength(loads + 2);
    });
  });

  it('every event carries the time it was recorded, in milliseconds', async () => {
    await start();
    const before = new Date().getTime();
    await sdk.trackView('checkout');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sdk.trackPurchase('checkout', 9.5);
    const after = new Date().getTime();
    await sdk.flush();

    const times: number[] = service.to('/public/sync').flatMap((c) => c.body.events.map((e: any) => e.timestamp));
    expect(times).toHaveLength(2);
    expect(times.every((t) => Number.isInteger(t) && t >= before && t <= after)).toBe(true);
    expect(times[0]).toBeLessThan(times[1]);
  });
});
